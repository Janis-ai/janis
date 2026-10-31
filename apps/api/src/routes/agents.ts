import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { AgentConfig, catalogModel, friendlyName, vendorForBaseUrl } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, agentApiKeys, agentConnections, agentInstructionRevisions, agentMembers, agentSecrets, agentTests, agentTestRuns, agentWidgets, alertRules, alerts, campaignSends, campaigns, channelBindings, channels, contactIdentities, conversations, evalSuggestions, helpArticles, helpSearchLog, knowledgeFiles, memberships, messages, pendingActions, savedReplies, slackInstallations, slackThreads, suggestions, usageEvents, users, webhookDeliveries, workspaces } from '../db/schema.js';
import { WidgetComponent, WidgetState, WidgetToolBinding } from '../lib/widgets.js';
import { toolsFor } from '../lib/toolExec.js';
import {
  adminOnly,
  agentAdminOnly,
  agentMemberOnly,
  sessionAuth,
  type SessionEnv,
} from '../middleware/sessionAuth.js';
import { generateApiKey, generateWebhookSecret } from '../lib/crypto.js';
import { opsAlert } from '../lib/opsAlert.js';
import { bus } from '../lib/bus.js';
import { env } from '../env.js';
import { deliverWebhook, replayDelivery } from '../lib/webhooks.js';
import { extractKnowledgeText, UnsupportedFileError } from '../lib/knowledge.js';
import { fetchUrlText, normalizeSourceUrl, refreshKnowledgeSource } from '../lib/urlSource.js';
import { fetchGoogleSourceText, googleSourceTarget, llmForAgent } from '../lib/googleSource.js';
import { importHelpCentre, MAX_KNOWLEDGE_SOURCES } from '../lib/helpCentreImport.js';
import {
  detectKnowledgeGaps,
  draftKnowledgeEntry,
  gapsCacheFresh,
  filterDismissedGaps,
  listLearnNotes,
  markGapsAdded,
  planCorrection,
  readGapsCache,
  recheckGaps,
} from '../services/knowledgeGaps.js';
import { encryptSecret, loadSecretsMap } from '../lib/secrets.js';
import { legacyBotDoc } from '../lib/legacyMongo.js';
import { resolveLegacyBotCreds } from '../lib/legacyDfCreds.js';
import { connectionSecrets } from '../lib/connections.js';
import { llmFor, MAX_KNOWLEDGE_CHARS, MAX_NOTES_CHARS, resolveWidgetRef, verifiedIdentityFor } from '../lib/hostedAgent.js';
import {
  contextOf,
  contextScore,
  formatExchange,
  matchPromptsSemantically,
  promptsSimilar,
  triggerOf,
  type MatchTurn,
} from '../lib/promptMatch.js';
import { checkpointIndices, checkPromptConflicts, draftExpectation, generateScenarioDrafts, judgeExpectation, replayContextFrom, runAgentTest, stripInternalTurns, transcriptTurns, type TestTurn } from '../lib/agentTests.js';
import { deleteAgentsCascade } from '../lib/agentCleanup.js';
import { recordRun } from '../lib/evalRuns.js';
import { configVersion } from '../lib/configVersion.js';
import { agentNameTaken, groupNameTaken } from '../lib/names.js';
import { recordLlmUsage } from '../lib/usage.js';
import { enqueueJob, runJobs } from '../lib/jobs.js';
import { applySuggestion, type SuggestionPatch } from '../lib/evalTriage.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { effectiveMeteredModel } from '../lib/llm.js';
import { llmModelsResult } from '../lib/llmModels.js';
import { agentRoleFor, agentScopeCond, isAdminRole } from '../lib/access.js';
import { effectivePlanKey } from '../lib/plans.js';
import { processEvents } from '../services/ingest.js';
import { toAgent } from '../lib/serializers.js';
import { stripe } from '../lib/stripe.js';
import { listIntentsV2, type ServiceAccount } from '../lib/dialogflow.js';
import { sendEmail } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { invalidateChannelCache } from '../lib/channels.js';
import { builtinCatalog } from '../lib/builtinTools.js';
import { TOOL_TEMPLATES } from '../lib/toolTemplates.js';
import { generateDraft } from '../lib/agentBuilder.js';
import { connectionSecretName, connectionToken } from '../lib/connections.js';
import {
  createSlackChannel,
  getInstallation,
  inviteWorkspaceMembers,
  sanitizeChannelName,
  slackChannelInfo,
} from '../lib/slack.js';

// Per-source auth headers — token-syntax names only (RFC 9110 tchar),
// hop-by-hop and framing headers denied so a pasted blob can't smuggle
// request-smuggling or override fetch's own framing. Max 8 per source.
const BLOCKED_SOURCE_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'proxy-authorization',
  'upgrade',
  'te',
  'trailer',
]);
const sourceHeadersSchema = z
  .record(z.string().max(1000))
  .refine((h) => Object.keys(h).length <= 8, 'at most 8 headers per source')
  .refine(
    (h) =>
      Object.keys(h).every(
        (k) =>
          /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]{1,64}$/.test(k) &&
          !BLOCKED_SOURCE_HEADERS.has(k.toLowerCase()),
      ),
    'invalid or forbidden header name',
  );

const createAgent = z.object({
  name: z.string().min(1).max(120),
  webhook_url: z.string().url().optional(),
  hosted: z.boolean().optional(),
  auto_resume_minutes: z.number().min(1).max(10080).optional(),
});
const bootstrapAgent = z.object({
  name: z.string().max(120).optional(),
  // Natural-language purpose — "what should this agent do". The builder
  // turns it into a draft configuration; blank just creates the agent.
  purpose: z.string().max(4000).optional(),
  hosted: z.boolean().optional(),
  auto_resume_minutes: z.number().min(1).max(10080).optional(),
});
const updateAgent = z.object({
  name: z.string().min(1).max(120).optional(),
  webhook_url: z.string().url().nullable().optional(),
  hosted: z.boolean().optional(),
  auto_resume_minutes: z.number().min(1).max(10080).nullable().optional(),
  // null clears the override back to the workspace alert channel
  // null inherits the workspace default, [] mutes Slack for this agent,
  // otherwise the exact destination list (channel_id null = the install's
  // own alert channel)
  slack_routes: z
    .array(
      z.object({
        installation_id: z.string(),
        channel_id: z.string().nullable().optional(),
      }),
    )
    .max(8)
    .nullable()
    .optional(),
  // legacy single-override fields — translated into a one-entry route
  slack_channel_id: z.string().nullable().optional(),
  slack_installation_id: z.string().nullable().optional(),
  config: AgentConfig.optional(),
});

export function agentRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));
  const agentAdmin = agentAdminOnly(db);
  const agentMember = agentMemberOnly(db);

  app.get('/', async (c) => {
    const scope = agentScopeCond(c.get('agentScope'));
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, c.get('workspaceId')), ...(scope ? [scope] : [])))
      // Alphabetical — every picker/nav surface expects a stable A–Z order
      // (was createdAt-desc; onboarding still lands on a predictable first).
      .orderBy(asc(sql`lower(${agents.name})`));
    return c.json({ agents: rows.map(toAgent) });
  });

  /** Shared agency-plan gate — agency children ride on the parent's plan
   *  and can't grow the fleet on their own. Returns the response to send,
   *  or null when creation may proceed. */
  const agencyGate = async (c: Context<SessionEnv>) => {
    const [ws] = await db
      .select({
        parentWorkspaceId: workspaces.parentWorkspaceId,
        parentContact: workspaces.parentContact,
        stripeSubscriptionId: workspaces.stripeSubscriptionId,
        connectSubscriptionId: workspaces.connectSubscriptionId,
      })
      .from(workspaces)
      .where(eq(workspaces.id, c.get('workspaceId')))
      .limit(1);
    if (!ws?.parentWorkspaceId || ws.stripeSubscriptionId || ws.connectSubscriptionId) {
      return null;
    }
    const [parent] = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, ws.parentWorkspaceId))
      .limit(1);
    return c.json(
      {
        error: `This account is covered by ${parent?.name ?? 'an agency plan'}. Contact ${ws.parentContact ?? 'your account administrator'} to add agents, or subscribe to your own plan.`,
        covered_by: parent?.name,
        contact: ws.parentContact,
      },
      402,
    );
  };

  /** Shared insert — agent row, its Slack alert channel when connected,
   *  and the audit entry. Both POST / and POST /bootstrap create through
   *  this so every path mints the same row shape. */
  const insertAgent = async (
    c: Context<SessionEnv>,
    fields: { name: string; hosted: boolean; webhook_url?: string; auto_resume_minutes?: number },
  ) => {
    const [row] = await db
      .insert(agents)
      .values({
        workspaceId: c.get('workspaceId'),
        ownerUserId: c.get('user').id,
        name: fields.name,
        // no API key until the operator generates one — hosted agents never call /v1
        webhookSecret: generateWebhookSecret(),
        webhookUrl: fields.webhook_url ?? null,
        hosted: fields.hosted,
        autoResumeMinutes: fields.auto_resume_minutes ?? 10,
      })
      .returning();
    // Give the agent its own Slack alert channel (#janis-{name}) when the
    // workspace is connected — best-effort: failures just fall back to the
    // workspace channel.
    const inst = await getInstallation(db, c.get('workspaceId'));
    if (inst) {
      const slug = sanitizeChannelName(`janis-${row.name}`) || 'janis-agent';
      const { channel } = await createSlackChannel(inst, slug);
      if (channel) {
        const routes = [{ installation_id: inst.id, channel_id: channel.id }];
        await db
          .update(agents)
          .set({ slackRoutes: routes })
          .where(eq(agents.id, row.id));
        row.slackRoutes = routes;
        void inviteWorkspaceMembers(db, inst, channel.id, row.id);
      }
    }
    await audit(db, {
      workspaceId: c.get('workspaceId'),
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'agent.create',
      targetType: 'agent',
      targetId: row.id,
      meta: { name: row.name, hosted: row.hosted },
    });
    return row;
  };

  app.post('/', adminOnly, zValidator('json', createAgent), async (c) => {
    const body = c.req.valid('json');
    const gate = await agencyGate(c);
    if (gate) return gate;
    if (await groupNameTaken(db, c.get('workspaceId'), body.name)) {
      return c.json({ error: `"${body.name}" is already a group's name` }, 409);
    }
    if (await agentNameTaken(db, c.get('workspaceId'), body.name)) {
      return c.json({ error: `"${body.name}" is already an agent's name` }, 409);
    }
    const row = await insertAgent(c, {
      name: body.name,
      hosted: body.hosted ?? false,
      webhook_url: body.webhook_url,
      auto_resume_minutes: body.auto_resume_minutes,
    });
    return c.json({ agent: toAgent(row) }, 201);
  });

  /** Guided-builder creation — one call that mints the agent AND, when a
   *  purpose description is given, drafts its starting configuration with
   *  the platform LLM: system prompt, greeting, and review-list
   *  suggestions (knowledge, integrations, approval gates, rules). The
   *  draft is review material stored under config.builder — nothing
   *  external is connected, gated, or armed by this endpoint. */
  app.post('/bootstrap', adminOnly, zValidator('json', bootstrapAgent), async (c) => {
    const body = c.req.valid('json');
    const gate = await agencyGate(c);
    if (gate) return gate;
    const hosted = body.hosted ?? true;
    const purpose = body.purpose?.trim() ?? '';
    const draft =
      hosted && purpose
        ? await generateDraft(purpose).catch((err) => {
            // Creation never blocks on the model — but a silent null is how
            // a failed draft ships as an empty "Guide it" step. Log the
            // reason so the blank-draft case is diagnosable in prod logs.
            console.error(
              '[bootstrap] generateDraft threw:',
              err instanceof Error ? err.message : err,
            );
            return null;
          })
        : null;
    const name = (body.name?.trim() || draft?.name || 'New agent').slice(0, 120);
    if (await groupNameTaken(db, c.get('workspaceId'), name)) {
      return c.json({ error: `"${name}" is already a group's name` }, 409);
    }
    if (await agentNameTaken(db, c.get('workspaceId'), name)) {
      return c.json({ error: `"${name}" is already an agent's name` }, 409);
    }
    const row = await insertAgent(c, {
      name,
      hosted,
      auto_resume_minutes: body.auto_resume_minutes,
    });
    if (purpose || draft) {
      const config = {
        ...(purpose ? { purpose: purpose.slice(0, 2000) } : {}),
        ...(draft?.system_prompt ? { system_prompt: draft.system_prompt } : {}),
        ...(draft?.tone ? { tone: draft.tone } : {}),
        ...(draft?.greeting ? { greeting: draft.greeting, greeting_enabled: true } : {}),
        builder: {
          ...(purpose ? { description: purpose.slice(0, 4000) } : {}),
          ...(draft?.summary ? { summary: draft.summary } : {}),
          ...(draft?.suggested_knowledge.length
            ? { suggested_knowledge: draft.suggested_knowledge }
            : {}),
          ...(draft?.suggested_templates.length
            ? { suggested_templates: draft.suggested_templates }
            : {}),
          ...(draft?.suggested_approvals.length
            ? { suggested_approvals: draft.suggested_approvals }
            : {}),
          ...(draft?.suggested_rules.length ? { suggested_rules: draft.suggested_rules } : {}),
          ...(draft?.suggested_questions.length
            ? { suggested_questions: draft.suggested_questions }
            : {}),
          ...(draft?.suggested_scenarios.length
            ? { suggested_scenarios: draft.suggested_scenarios }
            : {}),
          ...(draft?.knowledge_need ? { knowledge_need: draft.knowledge_need } : {}),
          ...(draft?.knowledge_need_reason
            ? { knowledge_need_reason: draft.knowledge_need_reason }
            : {}),
          ...(draft?.region_sensitive ? { region_sensitive: true } : {}),
          ...(draft?.domain_risk ? { domain_risk: draft.domain_risk } : {}),
          ...(draft?.suggested_channels?.length
            ? { suggested_channels: draft.suggested_channels }
            : {}),
          generated_at: new Date().toISOString(),
        },
      };
      const [updated] = await db
        .update(agents)
        .set({ config })
        .where(eq(agents.id, row.id))
        .returning();
      // Materialize the draft's test checklist — Try it runs real
      // scenarios, not an empty chat box. Creation never blocks on this.
      if (draft?.suggested_scenarios.length) {
        await db
          .insert(agentTests)
          .values(
            draft.suggested_scenarios.map((s) => ({
              workspaceId: c.get('workspaceId'),
              agentId: row.id,
              name: s.prompt.slice(0, 120),
              expectation: s.expected,
              turns: [{ role: 'customer' as const, text: s.prompt }] as never,
              category: s.category,
              source: 'generated',
            })),
          )
          .catch(() => undefined);
      }
      return c.json(
        {
          agent: toAgent(updated),
          draft: draft ?? {
            generated: false,
            note: env.llmApiKey
              ? 'the draft generator returned nothing — starting from a blank configuration'
              : 'no platform LLM key configured — starting from a blank configuration',
          },
        },
        201,
      );
    }
    return c.json({ agent: toAgent(row), draft: { generated: false } }, 201);
  });

  app.patch('/:id', agentAdmin, zValidator('json', updateAgent), async (c) => {
    const body = c.req.valid('json');
    const workspaceId = c.get('workspaceId');
    // Translate the legacy single-override fields into the routes model:
    // both null clears back to inherit; otherwise it's a one-entry route on
    // the given (or the agent's current/default) installation.
    // NB: `?.map` alone would collapse null→undefined — a null PATCH must
    // reach the write as null (clear to inherit), not "field absent".
    let routesPatch: { installation_id: string; channel_id: string | null }[] | null | undefined =
      body.slack_routes === null
        ? null
        : body.slack_routes?.map((r) => ({ ...r, channel_id: r.channel_id ?? null }));
    if (
      routesPatch === undefined &&
      (body.slack_channel_id !== undefined || body.slack_installation_id !== undefined)
    ) {
      if (body.slack_channel_id == null && body.slack_installation_id == null) {
        routesPatch = null;
      } else {
        let instId = body.slack_installation_id ?? undefined;
        if (!instId) {
          const [cur] = await db
            .select({ routes: agents.slackRoutes })
            .from(agents)
            .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, workspaceId)))
            .limit(1);
          instId = cur?.routes?.[0]?.installation_id;
        }
        if (!instId) {
          const def = await getInstallation(db, workspaceId);
          instId = def?.id;
        }
        if (!instId) return c.json({ error: 'slack not connected' }, 400);
        routesPatch = [{ installation_id: instId, channel_id: body.slack_channel_id ?? null }];
      }
    }
    // Every route's install must belong to this workspace and its channel
    // must resolve there — otherwise alerts would silently fail.
    if (routesPatch) {
      const insts = await db
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.workspaceId, workspaceId));
      const byId = new Map(insts.map((i) => [i.id, i]));
      for (const r of routesPatch) {
        const inst = byId.get(r.installation_id);
        if (!inst) return c.json({ error: 'slack workspace not found' }, 400);
        if (!r.channel_id) continue;
        const info = await slackChannelInfo(inst.botToken, r.channel_id);
        if (!info) return c.json({ error: 'channel not found in Slack' }, 400);
        if (info.isArchived) return c.json({ error: 'that channel is archived' }, 400);
      }
    }
    let configToSave = body.config;
    let llmVendorAlert: string | undefined;
    // llm.api_key is write-only — reads return key_set instead. Merge so a
    // config save doesn't wipe the key: undefined/'' keep, null clears,
    // a real string replaces.
    if (body.config?.llm) {
      const [existing] = await db
        .select({ config: agents.config })
        .from(agents)
        .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
        .limit(1);
      const storedKey =
        (((existing?.config ?? {}) as { llm?: { api_key?: string } }).llm?.api_key as string) ?? '';
      const { key_set: _ignored, ...llm } = body.config.llm;
      if (llm.api_key === null) delete llm.api_key;
      else if (!llm.api_key) llm.api_key = storedKey || undefined;
      configToSave = { ...body.config, llm };
      // Free plan: the effective metered model is locked to the current
      // selection — picking a different hosted LLM tier requires upgrading.
      // Resolution includes the workspace default under this override; BYOK
      // results are exempt, and moving onto the env default always works so
      // a lock can't trap anyone.
      const after = await effectiveMeteredModel(db, c.get('workspaceId'), configToSave);
      if (after !== null) {
        const before = await effectiveMeteredModel(db, c.get('workspaceId'), existing?.config);
        if (
          after !== before &&
          after !== env.llmModel &&
          (await effectivePlanKey(db, c.get('workspaceId'))) === 'free'
        ) {
          return c.json(
            {
              error:
                'Changing the hosted LLM model requires a paid Janis plan — upgrade under Billing, or switch to bring-your-own-key.',
              llm_locked: true,
            },
            402,
          );
        }
      }
      // First external adoption of a non-default vendor → ping ops so the
      // vendor account gets topped up before real traffic hits its tier.
      // BYOK is exempt (their key, not ours), as is the operator workspace.
      const newVendor = llm.api_key
        ? undefined
        : catalogModel(llm.model as string)?.vendor;
      if (
        newVendor &&
        newVendor !== vendorForBaseUrl(env.llmBaseUrl) &&
        c.get('workspaceId') !== env.operatorWorkspaceId
      ) {
        const siblings = await db
          .select({ config: agents.config })
          .from(agents)
          .where(
            and(
              eq(agents.workspaceId, c.get('workspaceId')),
              sql`${agents.id} != ${c.req.param('id')}`,
            ),
          );
        const already = siblings.some((s) => {
          const m = ((s.config ?? {}) as { llm?: { model?: string; api_key?: string } }).llm;
          return m?.model && !m.api_key && catalogModel(m.model)?.vendor === newVendor;
        });
        if (!already) llmVendorAlert = newVendor;
      }
    }
    // builtin_tools additions go through the same rules as the dedicated
    // /builtin-tools endpoint — only platform-flagged catalog entries
    // (customer-armable tools like web_search) may be added; operator-
    // gated concierge builtins can't be smuggled onto regular agents on
    // ANY workspace. A paid plan is required on customer workspaces.
    if (configToSave?.builtin_tools !== undefined) {
      const [cur] = await db
        .select({ config: agents.config })
        .from(agents)
        .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, workspaceId)))
        .limit(1);
      const before = new Set(
        ((cur?.config ?? {}) as { builtin_tools?: string[] }).builtin_tools ?? [],
      );
      const added = (configToSave.builtin_tools as string[]).filter((n) => !before.has(n));
      if (added.length) {
        const catalog = builtinCatalog(workspaceId);
        const bad = added.find((n) => !catalog.find((t) => t.name === n && t.available && t.platform));
        if (bad) return c.json({ error: `"${bad}" isn't an available platform tool` }, 400);
        if (
          workspaceId !== env.operatorWorkspaceId &&
          (await effectivePlanKey(db, workspaceId)) === 'free'
        ) {
          return c.json(
            { error: 'Platform tools require a paid plan — upgrade under Billing.', plan_required: true },
            402,
          );
        }
      }
    }
    if (body.name !== undefined) {
      if (await groupNameTaken(db, workspaceId, body.name)) {
        return c.json({ error: `"${body.name}" is already a group's name` }, 409);
      }
      if (await agentNameTaken(db, workspaceId, body.name, c.req.param('id'))) {
        return c.json({ error: `"${body.name}" is already an agent's name` }, 409);
      }
    }
    // Guidance versioning needs the prior config for the diff.
    const [prevCfg] = configToSave !== undefined
      ? await db
          .select({ config: agents.config })
          .from(agents)
          .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
          .limit(1)
      : [undefined];
    const [row] = await db
      .update(agents)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.webhook_url !== undefined ? { webhookUrl: body.webhook_url } : {}),
        ...(body.hosted !== undefined ? { hosted: body.hosted } : {}),
        ...(body.auto_resume_minutes !== undefined
          ? { autoResumeMinutes: body.auto_resume_minutes }
          : {}),
        ...(routesPatch !== undefined ? { slackRoutes: routesPatch } : {}),
        ...(configToSave !== undefined ? { config: configToSave } : {}),
      })
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    // Snapshot the guidance surface (instructions/greeting/quick replies)
    // whenever it actually changes — append-only edit history.
    if (prevCfg !== undefined) {
      type G = {
        system_prompt?: string;
        greeting?: string;
        quick_replies?: unknown[];
        tone?: string;
      };
      const before = (prevCfg.config ?? {}) as G;
      const after = (row.config ?? {}) as G;
      if (
        (before.system_prompt ?? '') !== (after.system_prompt ?? '') ||
        (before.greeting ?? '') !== (after.greeting ?? '') ||
        (before.tone ?? '') !== (after.tone ?? '') ||
        JSON.stringify(before.quick_replies ?? []) !== JSON.stringify(after.quick_replies ?? [])
      ) {
        await db.insert(agentInstructionRevisions).values({
          agentId: row.id,
          workspaceId: row.workspaceId,
          systemPrompt: after.system_prompt ?? '',
          greeting: after.greeting ?? '',
          quickReplies: after.quick_replies ?? [],
          tone: after.tone ?? null,
          createdBy: c.get('user').id,
        });
      }
    }
    if (llmVendorAlert) {
      opsAlert(
        `LLM vendor adopted — workspace ${c.get('workspaceId')} pinned an agent to ${llmVendorAlert}; check that vendor account's balance/rate tier`,
      );
    }
    // New alert destinations → every member needs to be in those channels
    // to see/act on alerts.
    if (routesPatch) {
      const insts = await db
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.workspaceId, workspaceId));
      const byId = new Map(insts.map((i) => [i.id, i]));
      for (const r of routesPatch) {
        const inst = byId.get(r.installation_id);
        if (inst && r.channel_id) {
          void inviteWorkspaceMembers(db, inst, r.channel_id, c.req.param('id'));
        }
      }
    }
    return c.json({ agent: toAgent(row) });
  });

  // Guidance edit history — every save that changed instructions/greeting/
  // quick replies, newest first. Previews only; restore reads the row itself.
  app.get('/:id/instruction-revisions', agentMember, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select({
        id: agentInstructionRevisions.id,
        systemPrompt: agentInstructionRevisions.systemPrompt,
        greeting: agentInstructionRevisions.greeting,
        quickReplies: agentInstructionRevisions.quickReplies,
        created_at: agentInstructionRevisions.createdAt,
        editor: users.name,
      })
      .from(agentInstructionRevisions)
      .leftJoin(users, eq(agentInstructionRevisions.createdBy, users.id))
      .where(eq(agentInstructionRevisions.agentId, agent.id))
      .orderBy(desc(agentInstructionRevisions.createdAt))
      .limit(100);
    return c.json({
      revisions: rows.map((r) => ({
        id: r.id,
        prompt_preview: r.systemPrompt.slice(0, 200),
        greeting: r.greeting,
        quick_replies: r.quickReplies,
        created_at: r.created_at.toISOString(),
        editor: r.editor,
      })),
    });
  });

  // Restore a prior guidance version — the restore itself snapshots, so the
  // history stays append-only rather than being rewritten.
  app.post('/:id/instruction-revisions/:revId/restore', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const [rev] = await db
      .select()
      .from(agentInstructionRevisions)
      .where(
        and(
          eq(agentInstructionRevisions.id, c.req.param('revId')),
          eq(agentInstructionRevisions.agentId, agent.id),
        ),
      )
      .limit(1);
    if (!rev) return c.json({ error: 'not found' }, 404);
    const newConfig = {
      ...(agent.config ?? {}),
      system_prompt: rev.systemPrompt,
      greeting: rev.greeting,
      quick_replies: rev.quickReplies,
      // Rows from before tone tracking keep the current tone on restore.
      ...(rev.tone != null ? { tone: rev.tone } : {}),
    };
    const [row] = await db
      .update(agents)
      .set({ config: newConfig })
      .where(eq(agents.id, agent.id))
      .returning();
    await db.insert(agentInstructionRevisions).values({
      agentId: row.id,
      workspaceId: row.workspaceId,
      systemPrompt: rev.systemPrompt,
      greeting: rev.greeting,
      quickReplies: rev.quickReplies,
      tone: rev.tone,
      createdBy: c.get('user').id,
    });
    return c.json({ agent: toAgent(row) });
  });

  // Live model list from an OpenAI-compatible endpoint. metered (or no
  // override) resolves env; otherwise fetches base_url/models with the
  // caller's key — or the stored key when the endpoint matches what's saved.
  // The env key is never sent to a non-env base_url.
  app.post(
    '/:id/llm-models',
    agentAdmin,
    zValidator(
      'json',
      z.object({
        base_url: z.string().optional(),
        api_key: z.string().optional(),
        metered: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');
      const [row] = await db
        .select({ config: agents.config })
        .from(agents)
        .where(
          and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))),
        )
        .limit(1);
      const stored =
        (((row?.config ?? {}) as { llm?: { api_key?: string; base_url?: string } }).llm) ?? {};
      const r = await llmModelsResult(stored, body);
      return c.json(r.body, r.status as 200 | 400);
    },
  );

  app.post('/:id/rotate-key', agentAdmin, async (c) => {
    const { key, hash, preview } = generateApiKey();
    const [row] = await db
      .update(agents)
      .set({ apiKeyHash: hash, apiKeyPreview: preview })
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ agent: toAgent(row), api_key: key });
  });

  const ownedAgentId = async (c: { req: { param: (n: string) => string }; get: (k: string) => string }) => {
    const [row] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    return row;
  };

  // Named API keys — list, create, revoke. The full key is returned once at
  // creation; rows are soft-deleted via revoked_at so usage history stays.
  app.get('/:id/api-keys', agentMember, async (c) => {
    if (!(await ownedAgentId(c))) return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.agentId, c.req.param('id')))
      .orderBy(desc(agentApiKeys.createdAt));
    return c.json({
      keys: rows.map((r) => ({
        id: r.id,
        label: r.label,
        preview: r.keyPreview,
        last_used_at: r.lastUsedAt?.toISOString() ?? null,
        revoked_at: r.revokedAt?.toISOString() ?? null,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  app.post(
    '/:id/api-keys',
    agentAdmin,
    zValidator('json', z.object({ label: z.string().min(1).max(60) })),
    async (c) => {
      if (!(await ownedAgentId(c))) return c.json({ error: 'not found' }, 404);
      const { label } = c.req.valid('json');
      const { key, hash, preview } = generateApiKey();
      const [row] = await db
        .insert(agentApiKeys)
        .values({ agentId: c.req.param('id'), label, keyHash: hash, keyPreview: preview })
        .returning();
      return c.json({ key: { id: row.id, label, preview, api_key: key } }, 201);
    },
  );

  app.post('/:id/api-keys/:keyId/revoke', agentAdmin, async (c) => {
    const [row] = await db
      .update(agentApiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(agentApiKeys.id, c.req.param('keyId')),
          eq(agentApiKeys.agentId, c.req.param('id')),
          isNull(agentApiKeys.revokedAt),
        ),
      )
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  // Revoke the implicit "Primary" key (the legacy api_key_hash column).
  app.post('/:id/api-keys/legacy/revoke', agentAdmin, async (c) => {
    const [row] = await db
      .update(agents)
      .set({ apiKeyHash: null, apiKeyPreview: null })
      .where(
        and(
          eq(agents.id, c.req.param('id')),
          eq(agents.workspaceId, c.get('workspaceId')),
        ),
      )
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/:id/rotate-webhook-secret', agentAdmin, async (c) => {
    const secret = generateWebhookSecret();
    const [row] = await db
      .update(agents)
      .set({ webhookSecret: secret })
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ agent: toAgent(row), webhook_secret: secret });
  });

  app.post('/:id/webhook-test', agentAdmin, async (c) => {
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    if (!row.webhookUrl && !row.hosted) {
      return c.json({ error: 'no webhook_url configured' }, 400);
    }
    await deliverWebhook(db, row, 'message.human', {
      conversation_id: 'webhook-test',
      janis_conversation_id: 'webhook-test',
      text: 'Janis webhook test — if you received this, your endpoint works.',
    });
    return c.json({ ok: true });
  });

  // Get-or-create the console test-chat channel — a webchat channel flagged
  // internal so it stays out of Integrations, but messages ride the real
  // /chat pipeline (ingest → agent → reply), so testing exercises exactly
  // what a visitor would hit, including handoffs. Any member may test.
  app.post('/:id/test-channel', agentMember, async (c) => {
    const [agent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const [existing] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.agentId, agent.id),
          eq(channels.kind, 'webchat'),
          sql`${channels.credentials}->>'internal' = 'true'`,
        ),
      )
      .limit(1);
    if (existing) return c.json({ channel_id: existing.id, agent_name: agent.name });
    const [ch] = await db
      .insert(channels)
      .values({
        workspaceId: c.get('workspaceId'),
        agentId: agent.id,
        kind: 'webchat',
        name: `Test — ${agent.name}`,
        credentials: { internal: true },
      })
      .returning();
    invalidateChannelCache();
    return c.json({ channel_id: ch.id, agent_name: agent.name }, 201);
  });

  // Reveal the webhook secret (needed to verify signatures agent-side)
  app.get('/:id/webhook-secret', agentAdmin, async (c) => {
    const [row] = await db
      .select({ webhookSecret: agents.webhookSecret })
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ webhook_secret: row.webhookSecret });
  });

  // Bot-platform ingest key — mints lazily; the card on the Channels page
  // shows the Chatfuel/ManyChat URLs built from it. Reusing a legacy
  // client_key needs no minting — the ingest matches either field.
  app.get('/:id/bot', agentMember, async (c) => {
    const [row] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    let key = (meta.bot_key ?? meta.legacy_client_key) as string | undefined;
    if (!key) {
      key = `bk_${randomBytes(16).toString('hex')}`;
      await db
        .update(agents)
        .set({ metadata: { ...meta, bot_key: key } })
        .where(eq(agents.id, c.req.param('id')));
    }
    return c.json({
      bot_key: key,
      urls: {
        chatfuel: `${env.apiOrigin}/bot/${key}/chatfuel`,
        manychat: `${env.apiOrigin}/bot/${key}/manychat`,
      },
    });
  });

  // Recent outbound webhook deliveries — for debugging agent wiring
  app.get('/:id/deliveries', agentMember, async (c) => {
    const [owned] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!owned) return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.agentId, owned.id))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(50);
    return c.json({
      deliveries: rows.map((r) => ({
        id: r.id,
        type: r.type,
        target_url: r.targetUrl,
        status: r.status,
        attempts: r.attempts,
        last_error: r.lastError,
        next_attempt_at: r.nextAttemptAt?.toISOString() ?? null,
        payload: r.payload,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  // Replay a failed delivery — fresh signature, fresh retry budget.
  app.post('/:id/deliveries/:deliveryId/replay', agentAdmin, async (c) => {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const ok = await replayDelivery(db, c.req.param('deliveryId'), agent);
    if (!ok) return c.json({ error: 'delivery not found or not failed' }, 404);
    await audit(db, {
      workspaceId: c.get('workspaceId'),
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'webhook.replay',
      targetType: 'agent',
      targetId: agent.id,
      meta: { delivery_id: c.req.param('deliveryId') },
    });
    return c.json({ ok: true });
  });

  // Test chat — try the agent without wiring a channel. One test conversation
  // per operator per agent.
  app.post(
    '/:id/chat',
    agentMember,
    zValidator('json', z.object({ text: z.string().min(1) })),
    async (c) => {
      const user = c.get('user');
      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
        .limit(1);
      if (!agent) return c.json({ error: 'not found' }, 404);

      const externalId = `webtest:${user.id}`;
      const { text } = c.req.valid('json');
      await processEvents(db, agent, [
        {
          type: 'message_in',
          conversation_id: externalId,
          text,
          user: { name: user.name, id: user.email },
        },
      ]);
      const [conv] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, externalId)))
        .limit(1);
      if (conv && conv.state !== 'human') {
        await deliverWebhook(db, agent, 'message.user', {
          conversation_id: externalId,
          janis_conversation_id: conv.id,
          text,
        });
      }
      return c.json({ conversation_id: conv?.id ?? null, state: conv?.state ?? null });
    },
  );

  const ownedAgent = async (c: {
    req: { param: (k: string) => string };
    get: (k: 'workspaceId') => string;
  }) => {
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    return row ?? null;
  };

  // Knowledge files — uploaded docs whose extracted text feeds the agent's prompt
  app.get('/:id/knowledge', agentMember, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const [rows, [art]] = await Promise.all([
      db
        .select()
        .from(knowledgeFiles)
        .where(eq(knowledgeFiles.agentId, agent.id))
        .orderBy(desc(knowledgeFiles.createdAt)),
      db
        .select({ total: sql<number>`coalesce(sum(length(${helpArticles.body})),0)::int` })
        .from(helpArticles)
        .where(and(eq(helpArticles.agentId, agent.id), eq(helpArticles.status, 'published'))),
    ]);
    // The same budget the injector enforces — enabled docs + published
    // articles + notes against MAX_KNOWLEDGE_CHARS (notes reserve
    // MAX_NOTES_CHARS first). The meter reads exactly this.
    const cfg = (agent.config ?? {}) as AgentConfig;
    const notesChars = (cfg.knowledge ?? []).reduce((n, k) => n + k.length, 0);
    // Same filter the injector applies — only enabled, extracted ('ready')
    // text reaches the prompt.
    const docsChars =
      rows
        .filter((r) => r.enabled && (r.status === 'ready' || r.status === 'degraded'))
        .reduce((n, r) => n + r.text.length, 0) + (art?.total ?? 0);
    return c.json({
      budget: {
        limit: MAX_KNOWLEDGE_CHARS,
        notes_limit: MAX_NOTES_CHARS,
        notes_chars: notesChars,
        docs_chars: docsChars,
        used_chars: notesChars + docsChars,
      },
      files: rows.map((r) => ({
        id: r.id,
        name: r.name,
        mime_type: r.mimeType,
        size_bytes: r.sizeBytes,
        chars: r.text.length,
        status: r.status,
        error: r.error,
        source_url: r.sourceUrl,
        parent_id: r.parentId,
        topic: r.topic,
        enabled: r.enabled,
        refresh_hours: r.refreshHours,
        has_headers: !!r.sourceHeadersEnc,
        last_fetched_at: r.lastFetchedAt?.toISOString() ?? null,
        text_changed_at: r.textChangedAt?.toISOString() ?? null,
        next_fetch_at: r.nextFetchAt?.toISOString() ?? null,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  // One source's full extracted text — the list projects only metadata;
  // the console lazy-loads this on row expand (files run to tens of KB).
  app.get('/:id/knowledge/:fileId', agentMember, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const [row] = await db
      .select()
      .from(knowledgeFiles)
      .where(and(eq(knowledgeFiles.id, c.req.param('fileId')), eq(knowledgeFiles.agentId, agent.id)))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({
      id: row.id,
      name: row.name,
      mime_type: row.mimeType,
      text: row.text,
      chars: row.text.length,
      status: row.status,
      error: row.error,
      source_url: row.sourceUrl,
      last_fetched_at: row.lastFetchedAt?.toISOString() ?? null,
      text_changed_at: row.textChangedAt?.toISOString() ?? null,
    });
  });

  // Include/exclude (the over-budget escape that keeps the content), the
  // per-source re-crawl toggle (refresh_hours null = manual only), and
  // credential rotation — headers replaces the stored auth blob, null
  // clears it, absent leaves it.
  app.patch(
    '/:id/knowledge/:fileId',
    agentAdmin,
    zValidator(
      'json',
      z.object({
        enabled: z.boolean().optional(),
        refresh_hours: z.number().int().min(1).max(24 * 30).nullable().optional(),
        headers: sourceHeadersSchema.nullable().optional(),
      }),
    ),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const { enabled, refresh_hours, headers } = c.req.valid('json');
      const set: Partial<typeof knowledgeFiles.$inferInsert> = {};
      if (enabled !== undefined) set.enabled = enabled;
      if (headers !== undefined)
        set.sourceHeadersEnc = headers ? encryptSecret(JSON.stringify(headers)) : null;
      if (refresh_hours !== undefined) {
        set.refreshHours = refresh_hours;
        set.nextFetchAt = refresh_hours
          ? new Date(Date.now() + refresh_hours * 3600_000)
          : null;
      }
      if (Object.keys(set).length === 0) return c.json({ ok: true });
      const [row] = await db
        .update(knowledgeFiles)
        .set(set)
        .where(
          and(eq(knowledgeFiles.id, c.req.param('fileId')), eq(knowledgeFiles.agentId, agent.id)),
        )
        .returning({ id: knowledgeFiles.id });
      if (!row) return c.json({ error: 'not found' }, 404);
      return c.json({ ok: true });
    },
  );

  // Bulk delete — the "drop this whole crawl" path. Scoped to the agent;
  // ids that don't match just don't count. Selecting a site row takes its
  // page children with it (one statement — the self-FK sees the whole set).
  app.post(
    '/:id/knowledge/bulk-delete',
    agentAdmin,
    zValidator('json', z.object({ ids: z.array(z.string().uuid()).min(1).max(500) })),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const { ids } = c.req.valid('json');
      const rows = await db
        .delete(knowledgeFiles)
        .where(
          and(
            eq(knowledgeFiles.agentId, agent.id),
            or(inArray(knowledgeFiles.id, ids), inArray(knowledgeFiles.parentId, ids)),
          ),
        )
        .returning({ id: knowledgeFiles.id });
      return c.json({ deleted: rows.length });
    },
  );

  /** Build-status snapshot — the six build steps as CAPABILITIES, not a
   *  checklist. Per step: 'done' = configured, 'pending' = available but
   *  untouched, 'na' = this agent doesn't need it (the create-draft
   *  suggested nothing and nothing was added). 'na' is only trusted when a
   *  draft ran — a blank/legacy agent can't prove teach/abilities are
   *  unneeded, so they stay 'pending' (available). Powers the sidebar's
   *  ✓/●/○/— markers, the Overview progress card, and the builder's
   *  next-step skipping. */
  app.get('/:id/build-status', agentMember, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const cfg = (agent.config ?? {}) as AgentConfig;
    const [files, chans, [docChars], [artChars], [artCounts]] = await Promise.all([
      db
        .select({ createdAt: knowledgeFiles.createdAt, fetchedAt: knowledgeFiles.lastFetchedAt })
        .from(knowledgeFiles)
        .where(eq(knowledgeFiles.agentId, agent.id)),
      db
        .select({
          id: channels.id,
          credentials: channels.credentials,
          kind: channels.kind,
          name: channels.name,
          createdAt: channels.createdAt,
        })
        .from(channels)
        .where(eq(channels.agentId, agent.id)),
      db
        .select({ total: sql<number>`coalesce(sum(length(${knowledgeFiles.text})),0)::int` })
        .from(knowledgeFiles)
        .where(
          and(
            eq(knowledgeFiles.agentId, agent.id),
            eq(knowledgeFiles.enabled, true),
            inArray(knowledgeFiles.status, ['ready', 'degraded']),
          ),
        ),
      db
        .select({ total: sql<number>`coalesce(sum(length(${helpArticles.body})),0)::int` })
        .from(helpArticles)
        .where(and(eq(helpArticles.agentId, agent.id), eq(helpArticles.status, 'published'))),
      db
        .select({
          total: sql<number>`count(*)::int`,
          published: sql<number>`count(*) filter (where ${helpArticles.status} = 'published')::int`,
        })
        .from(helpArticles)
        .where(eq(helpArticles.agentId, agent.id)),
    ]);
    const internalIds = chans
      .filter((ch) => (ch.credentials as { internal?: boolean }).internal === true)
      .map((ch) => ch.id);
    const publicChans = chans.filter(
      (ch) => (ch.credentials as { internal?: boolean }).internal !== true,
    );
    const publicIds = publicChans.map((ch) => ch.id);
    const publicCount = publicIds.length;
    // Launch = the moment the first public channel connected — the channel's
    // own created_at is the launch timestamp, no separate flag to maintain.
    const firstChan = [...publicChans].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    )[0];
    let testConversations = 0;
    if (internalIds.length) {
      const [row] = await db
        .select({ n: sql<number>`count(distinct ${channelBindings.conversationId})` })
        .from(channelBindings)
        .where(inArray(channelBindings.channelId, internalIds));
      testConversations = Number(row?.n ?? 0);
    }
    // Launch happens at connection: a public channel's existence marks the
    // agent live (Deploy step done, nav flips to live mode). The first real
    // conversation is a health signal, not the launch gate — it still shows
    // up in the Deploy subtitle as "added · no messages yet".
    // Console-originated participants don't count as live traffic: the
    // Bubble editor's live preview chats as 'preview…' visitors on the real
    // channel, 'cust_…' is a simulated customer, 'u:…' a signed-in operator.
    let liveConversations = 0;
    if (publicIds.length) {
      const [row] = await db
        .select({ n: sql<number>`count(distinct ${channelBindings.conversationId})` })
        .from(channelBindings)
        .where(
          and(
            inArray(channelBindings.channelId, publicIds),
            sql`left(${channelBindings.platformUserId}, 7) <> 'preview'`,
            sql`left(${channelBindings.platformUserId}, 5) <> 'cust_'`,
            sql`left(${channelBindings.platformUserId}, 2) <> 'u:'`,
          ),
        );
      liveConversations = Number(row?.n ?? 0);
    }
    // Try-it scenarios — the saved checklist that becomes the regression
    // suite. A verdict stored against an older config fingerprint is
    // stale, not reviewed: the fix you're testing may have changed it.
    const cfgVersion = configVersion(cfg);
    // Aggregated in SQL — the suite can grow to thousands of rows; a
    // full-row fetch just to count would tax every status poll.
    // Effective outcome — a human pass/fail overrides the judge; absent a
    // verdict the machine result counts. 'unreviewed' (a fresh panel run
    // voided the prior verdict) falls through to the stored run —
    // 'fixed_recheck' excepted, whose last run is pre-fix → no outcome.
    const machinePassed = sql`(${agentTests.lastRun}->>'passed')::boolean`;
    const staleCond = sql`(${agentTests.configVersion} is not null and ${agentTests.configVersion} <> ${cfgVersion})`;
    const freshCond = sql`(${agentTests.configVersion} is null or ${agentTests.configVersion} = ${cfgVersion})`;
    const outcomePass = sql`(${agentTests.humanResult} = 'pass' or (${agentTests.humanResult} is distinct from 'fail' and ${agentTests.humanResult} is distinct from 'fixed_recheck' and ${machinePassed} is true))`;
    const outcomeFail = sql`(${agentTests.humanResult} = 'fail' or (${agentTests.humanResult} is distinct from 'pass' and ${agentTests.humanResult} is distinct from 'fixed_recheck' and ${machinePassed} is false))`;
    const [tcRows, uncheckedRows] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)::int`,
          freshTotal: sql<number>`count(*) filter (where ${freshCond})::int`,
          passing: sql<number>`count(*) filter (where ${freshCond} and ${outcomePass})::int`,
          failing: sql<number>`count(*) filter (where ${freshCond} and ${outcomeFail})::int`,
          run: sql<number>`count(*) filter (where ${agentTests.humanResult} is not null or ${agentTests.lastRun} is not null)::int`,
          // 'checked' = a human verdict was given (pass or fail);
          // 'unreviewed' means the scenario ran but nobody judged it yet.
          checked: sql<number>`count(*) filter (where ${agentTests.humanResult} in ('pass','fail'))::int`,
          stale: sql<number>`count(*) filter (where ${staleCond})::int`,
          fixed: sql<number>`count(*) filter (where ${agentTests.humanResult} = 'fixed_recheck')::int`,
          safetyTotal: sql<number>`count(*) filter (where ${agentTests.category} = 'safety')::int`,
          safetyChecked: sql<number>`count(*) filter (where ${agentTests.category} = 'safety' and ${agentTests.humanResult} in ('pass','fail'))::int`,
        })
        .from(agentTests)
        .where(eq(agentTests.agentId, agent.id)),
      // Names of what isn't green — the nav chip tooltip lists them so
      // the counts are inspectable, not just numbers.
      db
        .select({ name: agentTests.name })
        .from(agentTests)
        .where(
          and(
            eq(agentTests.agentId, agent.id),
            sql`(${staleCond} or not ${outcomePass})`,
          ),
        )
        .limit(6),
    ]);
    const tc = tcRows[0];
    const testsTotal = Number(tc.total);
    const testsPassing = Number(tc.passing);
    const testsFailing = Number(tc.failing);
    // Fresh but no passing/failing outcome — never ran, unrunnable (no
    // expectation to judge against), or a fixed scenario awaiting re-run.
    const testsUnrun = Number(tc.freshTotal) - testsPassing - testsFailing;
    const testsRun = Number(tc.run);
    const testsChecked = Number(tc.checked);
    const testsStale = Number(tc.stale);
    const safetyChecked = Number(tc.safetyChecked);
    const uncheckedNames = uncheckedRows.map((r) => r.name);
    const sources = (cfg.knowledge?.length ?? 0) + files.length;
    const updatedAt = files
      .map((f) => f.fetchedAt ?? f.createdAt)
      .reduce<Date | null>((m, d) => (!m || d > m ? d : m), null);
    const abilities = (cfg.tools?.length ?? 0) + (cfg.builtin_tools?.length ?? 0);
    const drafted = !!cfg.builder?.generated_at;
    const suggestedKnowledge = (cfg.builder?.suggested_knowledge?.length ?? 0) > 0;
    const suggestedAbilities =
      (cfg.builder?.suggested_templates?.length ?? 0) +
        (cfg.builder?.suggested_approvals?.length ?? 0) >
      0;
    // Suggested templates the owner never installed — a builtin tool like
    // web_search must not mask these or the step lies ✓ while the brief's
    // integrations sit unconnected.
    const dismissedT = new Set(cfg.builder?.dismissed_templates ?? []);
    const unmetTemplates = (cfg.builder?.suggested_templates ?? []).filter(
      (t) => !dismissedT.has(t.id) && !(cfg.tools ?? []).some((x) => x.template === t.id),
    ).length;
    // Cached gaps only — build-status must never trigger a detection run.
    const gapCache = readGapsCache(cfg);
    const openGaps = gapCache
      ? markGapsAdded(
          filterDismissedGaps(gapCache.gaps, cfg),
          cfg.knowledge ?? [],
        ).filter((g) => !g.added).length
      : 0;
    // Marks carry meaning, not visited-ness: done = a human confirmed or
    // acted, partial = something exists but is unconfirmed/needs a look
    // (Janis draft, unreviewed suggestions, open gaps), pending = nothing.
    return c.json({
      steps: {
        create: 'done',
        teach:
          sources > 0
            ? 'done'
            : // skipped is 'na' like not-needed — but distinct: the user
              // chose it, so teach_skipped rides along for the subtitle.
              cfg.builder?.teach_skipped ||
                cfg.builder?.knowledge_need === 'unnecessary' ||
                (drafted && !suggestedKnowledge)
              ? 'na'
              : 'pending',
        guide: cfg.system_prompt?.trim()
          ? cfg.builder?.guide_confirmed
            ? 'done'
            : 'partial'
          : 'pending',
        abilities:
          // An explicit "none needed" outranks the draft's uninstalled
          // suggestions — the owner reviewed them and decided.
          cfg.builder?.abilities_confirmed
            ? 'done'
            : unmetTemplates > 0 || (abilities === 0 && suggestedAbilities)
              ? 'partial'
              : abilities > 0
                ? 'done'
                : drafted
                  ? 'na'
                  : 'pending',
        try:
          testsTotal > 0
            ? // ✓ every scenario has a fresh passing outcome (machine runs
              // count — no per-row approval needed); ◐ anything failing,
              // unrun, or stale; ○ nothing ran.
              testsFailing === 0 && testsUnrun === 0 && testsStale === 0
              ? 'done'
              : testsRun > 0 || testConversations > 0
                ? 'partial'
                : 'pending'
            : testConversations > 0
              ? openGaps > 0
                ? 'partial'
                : 'done'
              : 'pending',
        // A connected public channel IS the launch — the owner pressed
        // Connect and the channel went live; whether traffic has arrived
        // yet is a subtitle detail, not the mark.
        deploy: publicCount === 0 ? 'pending' : 'done',
      },
      knowledge: {
        sources,
        notes: cfg.knowledge?.length ?? 0,
        updated_at: updatedAt?.toISOString() ?? null,
        // Notes + enabled docs + published articles vs the injection cap —
        // same math the Teach it meter reads from GET /knowledge.
        over_budget:
          (cfg.knowledge ?? []).reduce((n, k) => n + k.length, 0) +
            (docChars?.total ?? 0) +
            (artChars?.total ?? 0) >
          MAX_KNOWLEDGE_CHARS,
      },
      teach_skipped: !!cfg.builder?.teach_skipped,
      abilities,
      abilities_unmet: unmetTemplates,
      channels: publicCount,
      launched_at: firstChan?.createdAt.toISOString() ?? null,
      launched_via: firstChan ? { name: firstChan.name, kind: firstChan.kind } : null,
      // The draft's harm call — the Deploy readiness block keeps the safety
      // row visible for elevated agents even when everything else is green.
      domain_risk: cfg.builder?.domain_risk ?? null,
      // Draft-vs-published articles — "unpublished help center" is one of
      // the readiness warnings.
      help_center: {
        total: Number(artCounts?.total ?? 0),
        published: Number(artCounts?.published ?? 0),
      },
      live_conversations: liveConversations,
      test_conversations: testConversations,
      open_gaps: openGaps,
      // Try-it scenario checklist — the rail subtitle reads these.
      test_scenarios: {
        total: testsTotal,
        checked: testsChecked,
        passing: testsPassing,
        failing: testsFailing,
        unrun: testsUnrun,
        // fix applied, re-run queued/in-flight — awaiting the re-verdict.
        fixed: Number(tc.fixed),
        stale: testsStale,
        safety_total: Number(tc.safetyTotal),
        safety_checked: safetyChecked,
        unchecked: uncheckedNames,
      },
    });
  });

  /** Re-draft a starting configuration from a (possibly revised) brief —
   *  review material only, nothing is written. The Create step's
   *  "brief changed → review suggested changes" flow calls this; applying
   *  is an explicit user action on top of the normal config PATCH. */
  app.post(
    '/:id/redraft',
    agentAdmin,
    zValidator('json', z.object({ description: z.string().min(1).max(4000) })),
    async (c) => {
      if (!(await ownedAgent(c))) return c.json({ error: 'not found' }, 404);
      const draft = await generateDraft(c.req.valid('json').description).catch((err) => {
        console.error(
          '[redraft] generateDraft threw:',
          err instanceof Error ? err.message : err,
        );
        return null;
      });
      return c.json({ draft });
    },
  );

  app.post('/:id/knowledge', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);

    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: 'file field required' }, 400);
    if (file.size > 10 * 1024 * 1024) return c.json({ error: 'file too large (max 10MB)' }, 413);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.agentId, agent.id));
    if (count >= MAX_KNOWLEDGE_SOURCES)
      return c.json({ error: `knowledge file limit reached (${MAX_KNOWLEDGE_SOURCES})` }, 409);

    const topic = form.get('topic');
    const buf = Buffer.from(await file.arrayBuffer());
    let text: string;
    try {
      text = await extractKnowledgeText(buf, file.type, file.name, await llmFor(db, agent));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'extraction failed';
      return c.json({ error: msg }, err instanceof UnsupportedFileError ? 415 : 422);
    }

    const [row] = await db
      .insert(knowledgeFiles)
      .values({
        workspaceId: c.get('workspaceId'),
        agentId: agent.id,
        name: file.name,
        ...(typeof topic === 'string' && topic.trim()
          ? { topic: topic.trim().slice(0, 80) }
          : {}),
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        text,
      })
      .returning();
    return c.json(
      {
        file: {
          id: row.id,
          name: row.name,
          mime_type: row.mimeType,
          size_bytes: row.sizeBytes,
          chars: row.text.length,
          status: row.status,
          created_at: row.createdAt.toISOString(),
        },
      },
      201,
    );
  });

  // URL knowledge sources — crawled on add and re-crawled by the sweeper on
  // the refresh cadence, so a stale FAQ page can't silently drift.
  // `headers` authenticates private sources (Notion tokens, gated docs) —
  // stored AES-256-GCM encrypted, never projected back (has_headers only).
  const urlBody = z.object({
    url: z.string().url().max(2000),
    refresh_hours: z.number().int().min(1).max(24 * 30).default(24),
    // Builder topic this source covers — the checklist tags rows so
    // "Covered · N sources" is provable, not a user claim.
    topic: z.string().max(80).optional(),
    headers: sourceHeadersSchema.optional(),
  });
  app.post('/:id/knowledge-url', agentAdmin, zValidator('json', urlBody), async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const { url, refresh_hours, topic, headers } = c.req.valid('json');
    // Rewrite shapes that can't serve content directly — a Google Doc /edit
    // link yields the editor shell, github blob pages yield site chrome.
    // The pasted URL stays as the display name; the normalized form is what
    // gets stored and re-crawled.
    const sourceUrl = normalizeSourceUrl(url);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.agentId, agent.id));
    if (count >= MAX_KNOWLEDGE_SOURCES)
      return c.json({ error: `knowledge file limit reached (${MAX_KNOWLEDGE_SOURCES})` }, 409);
    // Google-file links fetch through the agent's Google connection so
    // private docs work; no usable grant falls back to the anonymous export
    // crawl (link-shared files still land). The google error wins over the
    // crawler's generic "HTTP 401" — it names the actual fix.
    const g = await fetchGoogleSourceText(
      db,
      c.get('workspaceId'),
      agent.id,
      sourceUrl,
      () => llmFor(db, agent),
    ).then(
      (r) => ({ r, err: null as Error | null }),
      (e: unknown) => ({ r: null, err: e instanceof Error ? e : new Error(String(e)) }),
    );
    let fetched: { text: string; sizeBytes: number; imageUrl?: string };
    if (g.r) {
      fetched = g.r;
    } else {
      try {
        fetched = await fetchUrlText(sourceUrl, { headers });
      } catch (err) {
        // A Google link with no usable grant that also fails anonymously is
        // almost always a private file — offer the connect flow, which is
        // what mints the grant this fetch needs. The UI reads the flag and
        // shows a Connect button inline.
        if (!g.err && googleSourceTarget(sourceUrl)) {
          return c.json(
            {
              error:
                'this Google file isn’t publicly shared — connect Google in Abilities → integrations to grant access to your Docs, Sheets and Slides, or share the file "anyone with the link"',
              google_connect: true,
            },
            422,
          );
        }
        return c.json(
          { error: g.err?.message ?? (err instanceof Error ? err.message : 'fetch failed') },
          422,
        );
      }
    }
    const now = new Date();
    const [row] = await db
      .insert(knowledgeFiles)
      .values({
        workspaceId: c.get('workspaceId'),
        agentId: agent.id,
        name: url,
        mimeType: 'text/url-source',
        sizeBytes: fetched.sizeBytes,
        text: fetched.text,
        sourceUrl,
        imageUrl: fetched.imageUrl ?? null,
        topic: topic ?? null,
        ...(headers ? { sourceHeadersEnc: encryptSecret(JSON.stringify(headers)) } : {}),
        refreshHours: refresh_hours,
        lastFetchedAt: now,
        nextFetchAt: new Date(now.getTime() + refresh_hours * 3600_000),
      })
      .returning();
    return c.json({ file: { id: row.id } }, 201);
  });

  // Whole-site import — paste a root and it lands as ONE site row with
  // discovered pages hanging underneath. Zendesk centres fill children
  // inline from the articles API; everything else falls back to the
  // sitemap and the sweeper's bounded re-crawl fills the stub children.
  // The site row's own cadence re-runs discovery (new pages index in,
  // dead pages mark then drop).
  app.post('/:id/knowledge-import', agentAdmin, zValidator('json', urlBody), async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const { url, refresh_hours, topic, headers } = c.req.valid('json');
    try {
      const result = await importHelpCentre(
        db,
        c.get('workspaceId'),
        agent.id,
        url,
        refresh_hours,
        {
          headers,
          headersEnc: headers ? encryptSecret(JSON.stringify(headers)) : undefined,
        },
        { topic },
      );
      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'import failed' }, 422);
    }
  });

  // Manual re-crawl — also how a failed source retries without waiting.
  app.post('/:id/knowledge/:fileId/refresh', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const [file] = await db
      .select()
      .from(knowledgeFiles)
      .where(and(eq(knowledgeFiles.id, c.req.param('fileId')), eq(knowledgeFiles.agentId, agent.id)))
      .limit(1);
    if (!file?.sourceUrl) return c.json({ error: 'not a URL source' }, 400);
    const ok = await refreshKnowledgeSource(db, file);
    return c.json({ ok });
  });

  // Source discovery for the builder's topic checklist — uses the agent's
  // OWN connected Brave integration (template 'brave' → BRAVE_API_KEY in
  // agent secrets), never a platform key: the operator's search budget,
  // their feature. Candidates come from the live response only — the
  // endpoint never composes or invents URLs. Returns
  // configured:false when Brave isn't connected so the UI can explain
  // rather than silently failing.
  app.post(
    '/:id/source-search',
    agentAdmin,
    zValidator('json', z.object({ query: z.string().min(2).max(300) })),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const cfg = (agent.config ?? {}) as AgentConfig;
      const connected = (cfg.tools ?? []).some((t) => t.template === 'brave');
      const key = connected ? (await loadSecretsMap(db, agent.id)).BRAVE_API_KEY : undefined;
      if (!key) return c.json({ configured: false, candidates: [] });
      const q = c.req.valid('json').query;
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`,
        {
          headers: { 'X-Subscription-Token': key, accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) return c.json({ error: `search failed (${res.status})` }, 502);
      const data = (await res.json()) as {
        web?: { results?: { title?: string; url?: string; description?: string }[] };
      };
      const candidates = (data.web?.results ?? [])
        .slice(0, 5)
        .flatMap((r) => {
          if (!r.url) return [];
          let domain = '';
          try {
            domain = new URL(r.url).hostname;
          } catch {
            return [];
          }
          return [
            {
              title: r.title ?? domain,
              url: r.url,
              domain,
              summary: r.description ?? '',
            },
          ];
        });
      return c.json({ configured: true, candidates });
    },
  );

  // Knowledge-gap loop: clusters of conversations where the agent asked for a
  // human — the recurring questions it's failing on. Operator drafts → edits →
  // approves; approved entries land in config.knowledge (prompt-visible).
  // Detection is cached on the agent (gaps_cache): recompute only when stale
  // or explicitly refreshed — otherwise every page load re-rolled the LLM
  // merge and the gap list visibly flickered.
  const computeAndCacheGaps = async (agent: typeof agents.$inferSelect) => {
    const gaps = await detectKnowledgeGaps(db, agent.id);
    const cache = { at: new Date().toISOString(), gaps };
    await db
      .update(agents)
      .set({
        config: { ...((agent.config ?? {}) as Record<string, unknown>), gaps_cache: cache },
      })
      .where(eq(agents.id, agent.id));
    return cache;
  };

  app.get('/:id/knowledge-gaps', agentMember, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const cached = readGapsCache(agent.config);
    const cache = gapsCacheFresh(cached) ? cached! : await computeAndCacheGaps(agent);
    const learnings = await listLearnNotes(db, agent.id);
    // Dismissed clusters are filtered server-side so every surface —
    // detail page, overview card — sees the same set. (The detail page
    // still filters client-side against its own config copy; same rules.)
    return c.json({ gaps: filterDismissedGaps(cache.gaps, agent.config), learnings, computed_at: cache.at });
  });

  // Force a fresh detection run — the operator's "Refresh" button.
  app.post('/:id/knowledge-gaps/refresh', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const cache = await computeAndCacheGaps(agent);
    return c.json({ gaps: filterDismissedGaps(cache.gaps, agent.config), computed_at: cache.at });
  });

  app.post(
    '/:id/knowledge-gaps/draft', agentAdmin, zValidator(
      'json',
      z.object({
        questions: z.array(z.string().min(1)).min(1).max(10),
        resolutions: z.array(z.string()).max(5).default([]),
      }),
    ),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const { questions, resolutions } = c.req.valid('json');
      const draft = await draftKnowledgeEntry(db, agent, questions, resolutions);
      return c.json({ draft });
    },
  );

  // Re-check clusters against the current knowledge base — the LLM marks
  // questions the agent can now handle; covered clusters are dismissed so
  // they stop surfacing.
  app.post('/:id/knowledge-gaps/recheck', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    // Audit the same clusters the operator sees — the cached set, not a fresh roll.
    const clusters = readGapsCache(agent.config)?.gaps ?? (await computeAndCacheGaps(agent)).gaps;
    const covered = await recheckGaps(db, agent, clusters);
    if (covered.length) {
      const cfg = (agent.config ?? {}) as Record<string, unknown> & {
        dismissed_gaps?: string[];
        dismissed_gap_times?: Record<string, string>;
      };
      const dismissed = new Set(cfg.dismissed_gaps ?? []);
      const times = { ...(cfg.dismissed_gap_times ?? {}) };
      const now = new Date().toISOString();
      for (const k of covered) {
        dismissed.add(k);
        times[k] = now;
        // store every phrasing too — a reclustered group keeps all dismissed
        // variants and stays hidden until it escalates again
        for (const q of clusters.find((cl) => cl.key === k)?.questions ?? []) {
          const qk = q.toLowerCase().slice(0, 60);
          dismissed.add(qk);
          times[qk] = now;
        }
      }
      await db
        .update(agents)
        .set({
          config: { ...cfg, dismissed_gaps: [...dismissed], dismissed_gap_times: times },
        })
        .where(eq(agents.id, agent.id));
    }
    return c.json({ covered });
  });

  // Failure diagnosis — reads the reply (against the customer's prompt, the
  // scenario's expectation, and what's connected) and guesses the cause:
  // knowledge | behavior | ability | expectation. `correction` is optional —
  // the inbox "Correct this" path supplies one; a scenario "Needs work"
  // diagnoses from the reply+expectation alone. `classified: false` means no
  // LLM verdict; the operator picks the cause.
  app.post(
    '/:id/correction-plan', agentAdmin, zValidator('json', z.object({
      customerText: z.string().max(2000).optional(),
      agentText: z.string().min(1).max(4000),
      correction: z.string().max(2000).optional(),
      expected: z.string().max(2000).optional(),
    })),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const { customerText, agentText, correction, expected } = c.req.valid('json');
      const cfg = (agent.config ?? {}) as AgentConfig;
      const abilities = [
        ...(cfg.tools ?? []).map((t) => t.name || t.template || 'tool'),
        ...(cfg.builtin_tools ?? []),
      ];
      return c.json(
        await planCorrection(db, agent, { customerText, agentText, correction, expected, abilities }),
      );
    },
  );

  // Approve an entry — append to config.knowledge without clobbering other keys.
  app.post(
    '/:id/knowledge-gaps', agentAdmin, zValidator('json', z.object({ entry: z.string().min(1).max(2000) })),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const cfg = (agent.config ?? {}) as Record<string, unknown> & { knowledge?: unknown };
      // Entries are one-per-line — split multi-line drafts so they land as
      // separate entries matching the textarea model, and strip markdown
      // decoration (bold, leading bullets) the draft model sometimes emits.
      const entries = c.req
        .valid('json')
        .entry.split('\n')
        .map((l) => l.trim().replace(/^[-*•]\s+/, '').replace(/\*\*/g, ''))
        .filter(Boolean);
      const knowledge = Array.isArray(cfg.knowledge) ? [...cfg.knowledge] : [];
      for (const entry of entries) {
        if (!knowledge.includes(entry)) knowledge.push(entry);
      }
      // Keep the cached gap set stable — only its "added" flags move, so the
      // page shows the approved cluster as covered instead of re-rolling.
      const cache = readGapsCache(agent.config);
      const gaps_cache = cache ? { ...cache, gaps: markGapsAdded(cache.gaps, knowledge) } : undefined;
      const [updated] = await db
        .update(agents)
        .set({ config: { ...cfg, knowledge, ...(gaps_cache ? { gaps_cache } : {}) } })
        .where(eq(agents.id, agent.id))
        .returning();
      return c.json({ agent: toAgent(updated) });
    },
  );

  // Agent secrets — API keys/credentials for tool calls. Write-only: the
  // list endpoint returns names + timestamps, never values.
  app.get('/:id/secrets', agentMember, async (c) => {
    if (!(await ownedAgent(c))) return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select({ name: agentSecrets.name, createdAt: agentSecrets.createdAt })
      .from(agentSecrets)
      .where(eq(agentSecrets.agentId, c.req.param('id')))
      .orderBy(agentSecrets.name);
    return c.json({
      secrets: rows.map((r) => ({ name: r.name, created_at: r.createdAt.toISOString() })),
    });
  });

  const secretBody = z.object({
    name: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'letters, digits, underscores — start with a letter'),
    value: z.string().min(1).max(4096),
  });

  app.put('/:id/secrets', agentAdmin, zValidator('json', secretBody), async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const { name, value } = c.req.valid('json');
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSecrets)
      .where(eq(agentSecrets.agentId, agent.id));
    const [existing] = await db
      .select({ id: agentSecrets.id })
      .from(agentSecrets)
      .where(and(eq(agentSecrets.agentId, agent.id), eq(agentSecrets.name, name)))
      .limit(1);
    if (!existing && count >= 50) return c.json({ error: 'secret limit reached (50)' }, 409);

    const valueEnc = encryptSecret(value);
    const [row] = existing
      ? await db
          .update(agentSecrets)
          .set({ valueEnc, updatedAt: new Date() })
          .where(eq(agentSecrets.id, existing.id))
          .returning()
      : await db
          .insert(agentSecrets)
          .values({ workspaceId: agent.workspaceId, agentId: agent.id, name, valueEnc })
          .returning();
    return c.json({ secret: { name: row.name, created_at: row.createdAt.toISOString() } });
  });

  app.delete('/:id/secrets/:name', agentAdmin, async (c) => {
    if (!(await ownedAgent(c))) return c.json({ error: 'not found' }, 404);
    const [row] = await db
      .delete(agentSecrets)
      .where(
        and(
          eq(agentSecrets.agentId, c.req.param('id')),
          eq(agentSecrets.name, c.req.param('name')),
        ),
      )
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  // A connection whose minted-token secret no remaining tool references is
  // orphaned — an OAuth grant that would keep refreshing on every run
  // unused (e.g. uninstalling OAuth-Calendly tools via the PAT card, which
  // shares the tool names but carries no connection itself). A custom tool
  // referencing CONN_* still counts as a live reference.
  const gcUnusedConnections = async (agentId: string, tools: AgentConfig['tools']) => {
    const refs = JSON.stringify(tools ?? []);
    for (const row of await db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.agentId, agentId))) {
      if (!refs.includes(connectionSecretName(row.provider))) {
        await db.delete(agentConnections).where(eq(agentConnections.id, row.id));
      }
    }
  };

  // Predefined connections — install a catalog template's tools + store its
  // credentials as agent secrets in one shot. Tools merge by name so
  // reinstalling updates rather than duplicating.
  app.post(
    '/:id/tools/install', agentAdmin, zValidator(
      'json',
      z.object({
        template: z.string(),
        fields: z.record(z.string(), z.string()).default({}),
      }),
    ),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const { template, fields } = c.req.valid('json');
      const tpl = TOOL_TEMPLATES.find((t) => t.id === template);
      if (!tpl) return c.json({ error: 'unknown template' }, 404);
      const missing = tpl.fields.filter((f) => !f.optional && !fields[f.key]?.trim()).map((f) => f.label);
      if (missing.length) return c.json({ error: `missing: ${missing.join(', ')}` }, 400);

      // OAuth templates: store the credentials and mint a token now so a bad
      // client_id/secret fails at connect time, not during a conversation.
      // oauth_connect templates are different — the authorization-code
      // callback owns the connection row; the install just lands the tools.
      if (tpl.connection && !tpl.oauth_connect) {
        const { provider } = tpl.connection;
        const creds = tpl.connection.credentials(fields);
        const [conn] = await db
          .insert(agentConnections)
          .values({
            agentId: agent.id,
            workspaceId: agent.workspaceId,
            provider,
            label: tpl.connection.label(fields),
            credentialsEnc: encryptSecret(JSON.stringify(creds)),
          })
          .onConflictDoUpdate({
            target: [agentConnections.agentId, agentConnections.provider],
            set: {
              label: tpl.connection.label(fields),
              credentialsEnc: encryptSecret(JSON.stringify(creds)),
              accessTokenEnc: null,
              expiresAt: null,
              updatedAt: new Date(),
            },
          })
          .returning();
        try {
          await connectionToken(db, conn);
        } catch (err) {
          await db.delete(agentConnections).where(eq(agentConnections.id, conn.id));
          return c.json(
            { error: `could not authenticate with ${tpl.name}: ${(err as Error).message}` },
            400,
          );
        }
      }

      for (const [name, value] of Object.entries(tpl.secrets(fields))) {
        const err = await upsertAgentSecret(db, agent.id, agent.workspaceId, name, value);
        if (err) return c.json({ error: err }, 409);
      }
      const cfg = (agent.config ?? {}) as AgentConfig;
      const names = new Set(tpl.tools.map((t) => t.name));
      const stamped = tpl.tools.map((t) => ({ ...t, template: tpl.id }));
      const tools = [...(cfg.tools ?? []).filter((t) => !names.has(t.name)), ...stamped];
      const [updated] = await db
        .update(agents)
        .set({ config: { ...cfg, tools } })
        .where(eq(agents.id, agent.id))
        .returning();
      await gcUnusedConnections(agent.id, tools);
      return c.json({ agent: toAgent(updated) });
    },
  );

  // Per-tool approval gates + on/off toggles on an installed template — the
  // UI's checkboxes. Matches tools by name so installs predating the
  // `template` marker still get managed (and get stamped on write). A
  // disabled tool stays in config — reinstall state intact — but toolsFor
  // filters it before the model ever sees it.
  app.patch(
    '/:id/tools/:template', agentAdmin,
    zValidator(
      'json',
      z.object({
        approvals: z.record(z.string(), z.boolean()).optional(),
        disabled: z.record(z.string(), z.boolean()).optional(),
      }),
    ),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const tpl = TOOL_TEMPLATES.find((t) => t.id === c.req.param('template'));
      if (!tpl) return c.json({ error: 'unknown template' }, 404);
      const { approvals = {}, disabled = {} } = c.req.valid('json');
      const names = new Set(tpl.tools.map((t) => t.name));
      const cfg = (agent.config ?? {}) as AgentConfig;
      const tools = (cfg.tools ?? []).map((t) => {
        if (!names.has(t.name)) return t;
        const touched = approvals[t.name] !== undefined || disabled[t.name] !== undefined;
        if (!touched) return t;
        const next = { ...t, template: tpl.id };
        if (approvals[t.name] !== undefined) next.approval = approvals[t.name] || undefined;
        if (disabled[t.name] !== undefined) next.disabled = disabled[t.name] || undefined;
        return next;
      });
      const [updated] = await db
        .update(agents)
        .set({ config: { ...cfg, tools } })
        .where(eq(agents.id, agent.id))
        .returning();
      return c.json({ agent: toAgent(updated) });
    },
  );

  // Remove a template's tools; secrets stay (they may be shared with custom
  // tools). The template's connection drops via gcUnusedConnections below —
  // reference-aware, so a custom tool still minting via CONN_* keeps it.
  app.delete('/:id/tools/:template', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const tpl = TOOL_TEMPLATES.find((t) => t.id === c.req.param('template'));
    if (!tpl) return c.json({ error: 'unknown template' }, 404);
    const cfg = (agent.config ?? {}) as AgentConfig;
    const names = new Set(tpl.tools.map((t) => t.name));
    const tools = (cfg.tools ?? []).filter((t) => !names.has(t.name));
    const [updated] = await db
      .update(agents)
      .set({ config: { ...cfg, tools } })
      .where(eq(agents.id, agent.id))
      .returning();
    await gcUnusedConnections(agent.id, tools);
    return c.json({ agent: toAgent(updated) });
  });

  // Platform tools — in-process builtins that need no credentials: the UI
  // toggle surface for config.builtin_tools. Only platform-flagged
  // catalog entries available to this workspace are listed — concierge
  // builtins (create_agent, teach_agent, …) never surface on a regular
  // agent, operator workspace included. Enabling on a free plan is 402 —
  // platform tools run on Janis infrastructure, not the customer's
  // accounts (the operator workspace is exempt).
  app.get('/:id/builtin-tools', agentMember, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const enabled = new Set(
      ((agent.config ?? {}) as { builtin_tools?: string[] }).builtin_tools ?? [],
    );
    return c.json({
      plan: await effectivePlanKey(db, agent.workspaceId),
      tools: builtinCatalog(agent.workspaceId)
        .filter((t) => t.available && t.platform)
        .map((t) => ({ name: t.name, description: t.description, enabled: enabled.has(t.name) })),
    });
  });

  app.patch(
    '/:id/builtin-tools',
    agentAdmin,
    zValidator('json', z.object({ name: z.string(), enabled: z.boolean() })),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const { name, enabled } = c.req.valid('json');
      const tool = builtinCatalog(agent.workspaceId).find(
        (t) => t.name === name && t.available && t.platform,
      );
      if (!tool) return c.json({ error: 'unknown or unavailable platform tool' }, 404);
      if (
        enabled &&
        agent.workspaceId !== env.operatorWorkspaceId &&
        (await effectivePlanKey(db, agent.workspaceId)) === 'free'
      ) {
        return c.json(
          { error: 'Platform tools require a paid plan — upgrade under Billing.', plan_required: true },
          402,
        );
      }
      const cfg = (agent.config ?? {}) as AgentConfig;
      const set = new Set(cfg.builtin_tools ?? []);
      if (enabled) set.add(name);
      else set.delete(name);
      const [updated] = await db
        .update(agents)
        .set({ config: { ...cfg, builtin_tools: [...set] } })
        .where(eq(agents.id, agent.id))
        .returning();
      bus.publish(agent.workspaceId, { type: 'agent', data: { id: agent.id } });
      return c.json({ agent: toAgent(updated) });
    },
  );

  // Saved in-conversation components — hand-built widgets the agent emits by
  // name ("WIDGET_REF: plans") so the content is deterministic, or pins to
  // the chat greeting (auto_greet). spec is a validated WidgetComponent.
  const widgetName = z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_-]*$/, 'start with a letter; letters, numbers, - and _ only');
  const widgetBody = z.object({
    name: widgetName,
    description: z.string().trim().max(200).optional().nullable(),
    spec: z.unknown(),
    states: z.array(WidgetState).max(12).optional(),
    tool: WidgetToolBinding.optional().nullable(),
    auto_greet: z.boolean().optional(),
  });

  // A bound tool must exist on this agent and be a plain read — gated tools
  // can't feed a display component (approval cards can't render mid-reply).
  const validToolBind = (agent: typeof agents.$inferSelect, tool: WidgetToolBinding | null | undefined) => {
    if (!tool) return { ok: true as const };
    const def = toolsFor(agent).find((t) => t.name === tool.name);
    if (!def) return { ok: false as const, error: `no tool named "${tool.name}" on this agent` };
    if (def.approval)
      return { ok: false as const, error: `"${tool.name}" is approval-gated — bind a read tool` };
    return { ok: true as const };
  };

  app.get('/:id/widgets', agentMember, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select()
      .from(agentWidgets)
      .where(eq(agentWidgets.agentId, agent.id))
      .orderBy(asc(agentWidgets.name));
    return c.json({ widgets: rows });
  });

  app.post('/:id/widgets', agentAdmin, zValidator('json', widgetBody), async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const body = c.req.valid('json');
    const spec = WidgetComponent.safeParse(body.spec);
    if (!spec.success) return c.json({ error: 'invalid spec', issues: spec.error.issues }, 400);
    const toolCheck = validToolBind(agent, body.tool);
    if (!toolCheck.ok) return c.json({ error: toolCheck.error }, 400);
    const [row] = await db
      .insert(agentWidgets)
      .values({
        agentId: agent.id,
        name: body.name,
        description: body.description || null,
        spec: spec.data,
        states: body.states ?? null,
        tool: body.tool ?? null,
        autoGreet: !!body.auto_greet,
      })
      .onConflictDoUpdate({
        target: [agentWidgets.agentId, agentWidgets.name],
        set: {
          description: body.description || null,
          spec: spec.data,
          states: body.states ?? null,
          tool: body.tool ?? null,
          autoGreet: !!body.auto_greet,
          updatedAt: new Date(),
        },
      })
      .returning();
    bus.publish(agent.workspaceId, { type: 'agent', data: { id: agent.id } });
    return c.json({ widget: row }, 201);
  });

  app.patch(
    '/:id/widgets/:wid',
    agentAdmin,
    zValidator('json', widgetBody.partial()),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const body = c.req.valid('json');
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description || null;
      if (body.spec !== undefined) {
        const spec = WidgetComponent.safeParse(body.spec);
        if (!spec.success) return c.json({ error: 'invalid spec', issues: spec.error.issues }, 400);
        patch.spec = spec.data;
      }
      if (body.states !== undefined) patch.states = body.states;
      if (body.tool !== undefined) {
        const toolCheck = validToolBind(agent, body.tool);
        if (!toolCheck.ok) return c.json({ error: toolCheck.error }, 400);
        patch.tool = body.tool;
      }
      if (body.auto_greet !== undefined) patch.autoGreet = body.auto_greet;
      const [row] = await db
        .update(agentWidgets)
        .set(patch)
        .where(and(eq(agentWidgets.id, c.req.param('wid')), eq(agentWidgets.agentId, agent.id)))
        .returning();
      if (!row) return c.json({ error: 'not found' }, 404);
      bus.publish(agent.workspaceId, { type: 'agent', data: { id: agent.id } });
      return c.json({ widget: row });
    },
  );

  app.delete('/:id/widgets/:wid', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const [row] = await db
      .delete(agentWidgets)
      .where(and(eq(agentWidgets.id, c.req.param('wid')), eq(agentWidgets.agentId, agent.id)))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    bus.publish(agent.workspaceId, { type: 'agent', data: { id: agent.id } });
    return c.json({ ok: true });
  });

  // POST /:id/widgets/test — resolve a component the same way a WIDGET_REF
  // would at chat time: the bound tool runs FOR REAL with the given ref data
  // (an admin preview, same trust as testing the tool itself), its result
  // maps into props/steps/rows/items, and the filled spec comes back next to
  // the raw result so the mapping can be written against the actual shape.
  const widgetTestBody = z.object({
    spec: z.unknown(),
    states: z.array(WidgetState).max(12).optional(),
    tool: WidgetToolBinding.nullish(),
    data: z.record(z.unknown()).optional(),
  });
  app.post('/:id/widgets/test', agentAdmin, zValidator('json', widgetTestBody), async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const body = c.req.valid('json');
    const spec = WidgetComponent.safeParse(body.spec);
    if (!spec.success) return c.json({ error: 'invalid spec', issues: spec.error.issues }, 400);
    const toolCheck = validToolBind(agent, body.tool ?? null);
    if (!toolCheck.ok) return c.json({ error: toolCheck.error }, 400);
    const cap: { args?: Record<string, unknown>; result?: string; error?: string } = {};
    const widget = await resolveWidgetRef(
      {
        spec: spec.data,
        states: body.states,
        tool: body.tool ?? undefined,
      },
      body.data,
      toolsFor(agent),
      {
        ...(await loadSecretsMap(db, agent.id)),
        ...(await connectionSecrets(db, agent.id)),
      },
      // The previewer is a signed-in admin — operator context, same as the
      // console's other operator surfaces.
      {
        db,
        convId: '',
        workspaceId: agent.workspaceId,
        identity: { emails: new Set(), operator: true },
      },
      new Set(),
      cap,
    );
    return c.json({
      widget,
      tool_args: cap.args,
      // The raw result (capped) — mappings get written against this shape.
      tool_result: cap.result?.slice(0, 8000),
      error: cap.error,
    });
  });

  app.delete('/:id/knowledge/:fileId', agentAdmin, async (c) => {
    if (!(await ownedAgent(c))) return c.json({ error: 'not found' }, 404);
    // Deleting a site row drops its page children too — the site IS the
    // source; orphaned pages serving stale text are worse than none. One
    // statement, so the self-FK sees parent and children leave together.
    const fileId = c.req.param('fileId');
    const rows = await db
      .delete(knowledgeFiles)
      .where(
        and(
          eq(knowledgeFiles.agentId, c.req.param('id')),
          or(eq(knowledgeFiles.id, fileId), eq(knowledgeFiles.parentId, fileId)),
        ),
      )
      .returning({ id: knowledgeFiles.id });
    if (!rows.length) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true, deleted: rows.length });
  });

  // Classic → hosted upgrade for migrated bots: pull the Dialogflow agent's
  // intents into a knowledge doc, snapshot the legacy engine for rollback,
  // then flip config.engine off 'dialogflow' so the hosted pipeline answers.
  // The DF agent itself is untouched — rollback restores the snapshot.
  app.post('/:id/convert-hosted', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const cfg = (agent.config ?? {}) as {
      engine?: string;
      dialogflow?: { project?: string; lang?: string };
    };
    if (cfg.engine !== 'dialogflow')
      return c.json({ error: 'not a legacy (dialogflow-engine) agent' }, 409);
    if (!cfg.dialogflow?.project)
      return c.json({ error: 'legacy bot has no dialogflow project configured' }, 409);
    const secrets = await loadSecretsMap(db, agent.id);
    let sa: ServiceAccount | undefined;
    try {
      sa = JSON.parse(secrets.DIALOGFLOW_SA_JSON ?? '');
    } catch {}
    if (!sa?.client_email || !sa.private_key)
      return c.json({ error: 'legacy bot missing DIALOGFLOW_SA_JSON secret' }, 409);

    const intents = await listIntentsV2(cfg.dialogflow.project, sa).catch(() => null);
    if (!intents) return c.json({ error: 'dialogflow intent list failed' }, 502);

    // One knowledge doc — per-intent files would blow MAX_KNOWLEDGE_SOURCES
    // on trained agents. Q/A sections match how FAQ knowledge reads.
    const sections: string[] = [];
    let phraseCount = 0;
    for (const i of intents) {
      const phrases = ((i.trainingPhrases ?? []) as { parts?: { text?: string }[] }[])
        .map((p) => (p.parts ?? []).map((pt) => pt.text ?? '').join('').trim())
        .filter(Boolean);
      const answers = ((i.messages ?? []) as { text?: { text?: string[] } }[])
        .flatMap((m) => m.text?.text ?? [])
        .filter((t) => typeof t === 'string' && t.trim());
      if (!phrases.length && !answers.length && !i.isFallback) continue;
      phraseCount += phrases.length;
      sections.push(
        [
          `## ${i.displayName ?? 'intent'}${i.isFallback ? ' (default fallback)' : ''}`,
          ...phrases.map((p: string) => `Q: ${p}`),
          ...(answers.length
            ? answers.map((a: string) => `A: ${a}`)
            : ['A: [rich response — rebuild in new Janis]']),
        ].join('\n'),
      );
    }
    if (!sections.length)
      return c.json({ error: 'no intents with content found on the Dialogflow agent' }, 422);
    const text = `# Dialogflow intent import — ${agent.name}\n\n${sections.join('\n\n')}`;
    if (text.length > MAX_KNOWLEDGE_CHARS)
      return c.json(
        { error: `intent export too large (${text.length} chars > ${MAX_KNOWLEDGE_CHARS})` },
        422,
      );
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.agentId, agent.id));
    if (count >= MAX_KNOWLEDGE_SOURCES)
      return c.json({ error: `knowledge file limit reached (${MAX_KNOWLEDGE_SOURCES})` }, 409);
    const [file] = await db
      .insert(knowledgeFiles)
      .values({
        workspaceId: c.get('workspaceId'),
        agentId: agent.id,
        name: 'dialogflow-intents.md',
        mimeType: 'text/markdown',
        sizeBytes: Buffer.byteLength(text),
        text,
      })
      .returning();

    const metadata = {
      ...((agent.metadata ?? {}) as Record<string, unknown>),
      legacy_engine: { engine: cfg.engine, dialogflow: cfg.dialogflow },
    };
    const nextCfg = { ...cfg };
    delete nextCfg.engine;
    await db.update(agents).set({ config: nextCfg, metadata }).where(eq(agents.id, agent.id));
    await audit(db, {
      workspaceId: c.get('workspaceId'),
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'agent.convert_hosted',
      targetType: 'agent',
      targetId: agent.id,
    });
    return c.json({
      ok: true,
      intents: intents.length,
      imported: sections.length,
      phrases: phraseCount,
      file_id: file.id,
    });
  });

  // Undo convert-hosted — restore the snapshotted engine/config so the
  // Dialogflow pipeline answers again. The imported knowledge file stays.
  app.post('/:id/rollback-legacy', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const snap = ((agent.metadata ?? {}) as {
      legacy_engine?: { engine?: string; dialogflow?: unknown };
    }).legacy_engine;
    if (!snap?.engine) return c.json({ error: 'no legacy engine snapshot' }, 404);
    const cfg = { ...((agent.config ?? {}) as Record<string, unknown>), engine: snap.engine, dialogflow: snap.dialogflow };
    const metadata = { ...((agent.metadata ?? {}) as Record<string, unknown>) };
    delete metadata.legacy_engine;
    await db.update(agents).set({ config: cfg, metadata }).where(eq(agents.id, agent.id));
    return c.json({ ok: true });
  });

  // Per-agent credential retry for migrated monitor agents. Team migration
  // resolves DF creds once — an OAuth-era bot whose grant was revoked lands
  // as engine:'monitor' with no way back. Re-reading the legacy bot doc lets
  // the owner re-connect Dialogflow on the classic dashboard and retry, and
  // picks up creds that appeared after the team migrated.
  app.post('/:id/retry-legacy-engine', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const legacyKey = ((agent.metadata ?? {}) as { legacy_client_key?: string }).legacy_client_key;
    if (!legacyKey) return c.json({ error: 'not a migrated legacy agent' }, 409);
    const cfg = (agent.config ?? {}) as { engine?: string; dialogflow?: { project?: string; lang?: string } };
    if (cfg.engine === 'dialogflow') return c.json({ error: 'already on the dialogflow engine' }, 409);
    const bot = await legacyBotDoc(legacyKey);
    if (!bot) return c.json({ error: 'legacy bot doc not found — the legacy lookup may be unavailable' }, 404);
    const creds = await resolveLegacyBotCreds(bot);
    if (!creds.project || !creds.saJson) {
      return c.json({ error: creds.reason ?? 'credentials still unavailable' }, 422);
    }
    const enc = encryptSecret(JSON.stringify(creds.saJson));
    const [secret] = await db
      .select()
      .from(agentSecrets)
      .where(and(eq(agentSecrets.agentId, agent.id), eq(agentSecrets.name, 'DIALOGFLOW_SA_JSON')))
      .limit(1);
    if (secret) {
      await db
        .update(agentSecrets)
        .set({ valueEnc: enc, updatedAt: new Date() })
        .where(eq(agentSecrets.id, secret.id));
    } else {
      await db
        .insert(agentSecrets)
        .values({ workspaceId: c.get('workspaceId'), agentId: agent.id, name: 'DIALOGFLOW_SA_JSON', valueEnc: enc });
    }
    await db
      .update(agents)
      .set({
        config: {
          ...cfg,
          engine: 'dialogflow',
          dialogflow: { project: creds.project, lang: bot.dialogflow?.agent_object?.defaultLanguageCode ?? 'en' },
        },
      })
      .where(eq(agents.id, agent.id));
    await audit(db, {
      workspaceId: c.get('workspaceId'),
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'agent.retry_legacy_engine',
      targetType: 'agent',
      targetId: agent.id,
    });
    return c.json({ ok: true, engine: 'dialogflow', project: creds.project });
  });

  app.delete('/:id', agentAdmin, async (c) => {
    const agentId = c.req.param('id');
    const workspaceId = c.get('workspaceId');
    // No ON DELETE CASCADE in the schema — deleteAgentsCascade walks every
    // agent-keyed table leaf-first (shared with the workspace delete so the
    // two paths can't drift — a shopify_shops row used to block this).
    const [row] = await db.transaction(async (tx) => {
      await deleteAgentsCascade(tx, [agentId]);
      return tx
        .delete(agents)
        .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
        .returning();
    });
    if (!row) return c.json({ error: 'not found' }, 404);
    // A migrated bot's legacy Stripe sub survives its Postgres row. Never
    // cancel it implicitly — one sub can cover several legacy bots — only on
    // an explicit ?cancel_subscription=1 from the UI. We report how many
    // other workspace agents still reference the same sub so the caller can
    // explain what billing remains.
    const legacySubId = (
      (row.metadata ?? {}) as { legacy_stripe?: { subscription_id?: string } }
    ).legacy_stripe?.subscription_id;
    let legacySubCanceled = false;
    let legacySubSiblings = 0;
    if (legacySubId) {
      const siblings = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            sql`${agents.metadata}->'legacy_stripe'->>'subscription_id' = ${legacySubId}`,
          ),
        );
      legacySubSiblings = siblings.length;
      if (c.req.query('cancel_subscription') === '1') {
        try {
          await stripe()?.subscriptions.cancel(legacySubId);
          legacySubCanceled = true;
        } catch (err) {
          console.error(`[agents] legacy sub ${legacySubId} cancel failed:`, err);
        }
      }
    }
    await audit(db, {
      workspaceId,
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'agent.delete',
      targetType: 'agent',
      targetId: agentId,
    });
    return c.json({
      ok: true,
      legacy_sub_canceled: legacySubCanceled,
      legacy_sub_retained: !!legacySubId && !legacySubCanceled,
      legacy_sub_siblings: legacySubSiblings,
    });
  });

  // ---- Agent members: per-agent role / identity / notification overrides ----
  // One row per (agent, user). role null = inherit the workspace role; users
  // with NO workspace membership and an accepted row see only that agent.

  const memberBody = z.object({
    email: z.string().email(),
    name: z.string().max(120).optional(),
    role: z.enum(['admin', 'member']).default('member'),
  });
  const memberPatch = z.object({
    // explicit null clears the override back to the workspace role.
    // 'hidden' = deny a workspace member this agent; 'owner' = transfer
    // ownership to them (only the current owner may do that).
    role: z.enum(['admin', 'member', 'hidden', 'owner']).nullable().optional(),
    display_name: z.string().max(80).nullable().optional(),
    avatar_url: z.string().max(2000).nullable().optional(),
    show_identity: z.boolean().nullable().optional(),
    notify: z
      .object({
        push: z.boolean().optional(),
        email: z.boolean().optional(),
        sound: z.boolean().optional(),
        events: z.record(z.string(), z.boolean()).optional(),
      })
      .nullable()
      .optional(),
  });
  const toMember = (
    m: typeof agentMembers.$inferSelect,
    u: typeof users.$inferSelect,
  ) => ({
    user_id: u.id,
    email: u.email,
    name: u.name,
    avatar_url: m.avatarUrl ?? u.avatarUrl,
    role: m.role,
    display_name: m.displayName,
    avatar_override: m.avatarUrl,
    show_identity: m.showIdentity,
    notify: m.notifyPrefs ?? null,
    status: m.acceptedAt ? ('active' as const) : ('invited' as const),
  });

  app.get('/:id/members', agentMember, async (c) => {
    const [agent] = await db
      .select({ ownerId: agents.ownerUserId })
      .from(agents)
      .where(eq(agents.id, c.req.param('id')))
      .limit(1);
    const rows = await db
      .select({ m: agentMembers, u: users })
      .from(agentMembers)
      .innerJoin(users, eq(agentMembers.userId, users.id))
      .where(eq(agentMembers.agentId, c.req.param('id')));
    return c.json({
      members: rows.map((r) => ({
        ...toMember(r.m, r.u),
        role: r.m.userId === agent?.ownerId ? ('owner' as const) : r.m.role,
      })),
    });
  });

  // Add (or re-role) an agent member by email. Workspace members get an
  // override row; unknown emails become agent-scoped users who see ONLY this
  // agent — they sign in with Google/Slack under the invited address.
  app.post('/:id/members', agentAdmin, zValidator('json', memberBody), async (c) => {
    const b = c.req.valid('json');
    const email = b.email.trim().toLowerCase();
    let [u] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (!u) {
      [u] = await db
        .insert(users)
        .values({ email, name: b.name?.trim() || email.split('@')[0] })
        .returning();
    }
    // A re-role upserts over an existing grant — only a genuinely new one
    // gets the "you've been added" email.
    const [prior] = await db
      .select({ id: agentMembers.id })
      .from(agentMembers)
      .where(and(eq(agentMembers.agentId, c.req.param('id')), eq(agentMembers.userId, u.id)))
      .limit(1);
    const [row] = await db
      .insert(agentMembers)
      .values({
        agentId: c.req.param('id'),
        userId: u.id,
        role: b.role,
        invitedBy: c.get('user').id,
        acceptedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [agentMembers.agentId, agentMembers.userId],
        set: { role: b.role },
      })
      .returning();
    if (!prior) {
      const me = c.get('user');
      const [agent] = await db
        .select({ name: agents.name, workspaceId: agents.workspaceId })
        .from(agents)
        .where(eq(agents.id, c.req.param('id')))
        .limit(1);
      const [ws] = agent
        ? await db
            .select({ name: workspaces.name })
            .from(workspaces)
            .where(eq(workspaces.id, agent.workspaceId))
            .limit(1)
        : [undefined];
      void sendEmail(
        [email],
        `${me.name} added you to ${agent?.name ?? 'an agent'} on Janis`,
        `Hi — ${me.name} gave you ${b.role} access to the agent "${agent?.name ?? ''}" in the "${ws?.name ?? ''}" workspace on Janis. Sign in with this email to see it:`,
        `/agents/${c.req.param('id')}`,
      ).catch((err) => console.error('agent grant email failed:', err));
    }
    return c.json({ member: toMember(row, u) }, 201);
  });

  // role/notify changes need agent admin; a member can always update their
  // OWN profile override for the agent. Workspace admins retain management
  // as the escape hatch (an override can't lock them out of member admin).
  // The agent's owner (agents.owner_user_id) can never be demoted, hidden,
  // or removed — role 'owner' transfers ownership to them and only the
  // current owner may send it (an admin may claim an owner-less agent).
  app.patch('/:id/members/:userId', zValidator('json', memberPatch), async (c) => {
    const me = c.get('user');
    const targetId = c.req.param('userId');
    const self = targetId === me.id;
    const myRole = await agentRoleFor(
      db, me.id, c.get('role'), c.get('agentScope'), c.req.param('id'), c.get('workspaceId'),
    );
    if (!myRole) return c.json({ error: 'not found' }, 404);
    const b = c.req.valid('json');
    const [agent] = await db
      .select({ ownerId: agents.ownerUserId })
      .from(agents)
      .where(eq(agents.id, c.req.param('id')))
      .limit(1);
    const wsAdmin = c.get('role') === 'admin' && !c.get('agentScope').grants;
    const manages = isAdminRole(myRole) || wsAdmin;
    // self-service: members update their own profile/notify override only —
    // role changes and editing others require agent (or workspace) admin
    if (b.role !== undefined && !manages) return c.json({ error: 'admin required' }, 403);
    if (!self && !manages) return c.json({ error: 'admin required' }, 403);
    if (b.role !== undefined && b.role !== 'owner' && targetId === agent?.ownerId) {
      return c.json({ error: 'the agent owner stays admin — transfer ownership instead' }, 409);
    }
    if (b.role === 'hidden') {
      // hiding only makes sense for workspace members — an agent-only user
      // with no row simply has no access, so DELETE their row instead.
      const [mem] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, targetId),
            eq(memberships.workspaceId, c.get('workspaceId')),
          ),
        )
        .limit(1);
      if (!mem) {
        return c.json({ error: 'no privileges only applies to workspace members — remove them instead' }, 400);
      }
    }
    if (b.role === 'owner') {
      if (agent?.ownerId !== me.id && agent?.ownerId != null) {
        return c.json({ error: 'only the agent owner can transfer ownership' }, 403);
      }
      await db
        .update(agents)
        .set({ ownerUserId: targetId })
        .where(eq(agents.id, c.req.param('id')));
      // any stored member-row role contradicts ownership — owner wins
      // regardless, so clear it back to inherit rather than leave a
      // vestigial override badge
      await db
        .update(agentMembers)
        .set({ role: null })
        .where(
          and(
            eq(agentMembers.agentId, c.req.param('id')),
            eq(agentMembers.userId, targetId),
            isNotNull(agentMembers.role),
          ),
        );
      const [u] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
      // give the new owner a member row (role null = inherit) so the row
      // exists for identity/notify overrides; effective role comes from
      // agents.owner_user_id either way.
      await db
        .insert(agentMembers)
        .values({
          agentId: c.req.param('id'),
          userId: targetId,
          invitedBy: me.id,
          acceptedAt: new Date(),
        })
        .onConflictDoNothing();
      const [row] = await db
        .select()
        .from(agentMembers)
        .where(
          and(eq(agentMembers.agentId, c.req.param('id')), eq(agentMembers.userId, targetId)),
        )
        .limit(1);
      return c.json({ member: { ...toMember(row!, u!), role: 'owner' } });
    }
    const set: Record<string, unknown> = {
      ...(b.role !== undefined ? { role: b.role } : {}),
      ...(b.display_name !== undefined ? { displayName: b.display_name } : {}),
      ...(b.avatar_url !== undefined ? { avatarUrl: b.avatar_url } : {}),
      ...(b.show_identity !== undefined ? { showIdentity: b.show_identity } : {}),
      ...(b.notify !== undefined ? { notifyPrefs: b.notify } : {}),
    };
    const [row] = await db
      .insert(agentMembers)
      .values({
        agentId: c.req.param('id'),
        userId: targetId,
        invitedBy: me.id,
        acceptedAt: new Date(),
        ...set,
      })
      .onConflictDoUpdate({
        target: [agentMembers.agentId, agentMembers.userId],
        set,
      })
      .returning();
    const [u] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    return c.json({ member: toMember(row, u!) });
  });

  app.delete('/:id/members/:userId', agentAdmin, async (c) => {
    // The owner can't be removed — they must pass ownership first. (For a
    // workspace member this only clears their override row; they still see
    // the agent unless an admin sets their role to 'hidden' instead.)
    const [agent] = await db
      .select({ ownerId: agents.ownerUserId })
      .from(agents)
      .where(eq(agents.id, c.req.param('id')))
      .limit(1);
    if (agent?.ownerId === c.req.param('userId')) {
      return c.json({ error: 'the agent owner cannot be removed — transfer ownership first' }, 409);
    }
    const [row] = await db
      .delete(agentMembers)
      .where(
        and(
          eq(agentMembers.agentId, c.req.param('id')),
          eq(agentMembers.userId, c.req.param('userId')),
        ),
      )
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  // ── Regression tests — saved transcripts replayed against current config ──
  // The flywheel's closing loop: rescue → gap → fix → proof it can't regress.

  const toTest = (t: typeof agentTests.$inferSelect, currentVersion?: string) => ({
    id: t.id,
    name: t.name,
    turns: t.turns,
    expectation: t.expectation,
    expectation_draft: t.expectationDraft,
    source_conversation_id: t.sourceConversationId,
    source_message_id: t.sourceMessageId,
    original_reply: t.originalReply,
    // The test replays hydrated with its saved session state — the UI
    // marks it so "replays live context" reads differently from a bare
    // text replay.
    has_replay_context: !!t.replayContext,
    last_run: t.lastRun,
    category: t.category,
    source: t.source,
    // The Try-it panel's human verdict — distinct from the judge's last_run.
    human_result: t.humanResult,
    // Why a 'fail' was judged wrong — drives the rescue fix card.
    fail_cause: t.failCause,
    human_run_at: t.humanRunAt?.toISOString() ?? null,
    // Stale = the config changed since the panel run — the verdict was
    // earned against a different agent and needs a re-run.
    stale: !!t.configVersion && currentVersion !== undefined && t.configVersion !== currentVersion,
    created_at: t.createdAt.toISOString(),
  });

  app.get('/:id/tests', agentMember, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const version = configVersion((agent.config ?? {}) as AgentConfig);
    // Paged mode is opt-in (?limit=…) — the scenario-match consumers
    // (test dock, inbox "save as test") keep full-list reads so fuzzy
    // matching still sees every scenario.
    const limitParam = c.req.query('limit');
    if (!limitParam) {
      const rows = await db
        .select()
        .from(agentTests)
        .where(eq(agentTests.agentId, agent.id))
        .orderBy(desc(agentTests.createdAt));
      return c.json({ tests: rows.map((t) => toTest(t, version)), config_version: version });
    }
    const limit = Math.min(Math.max(parseInt(limitParam, 10) || 0, 1), 500);
    const filter = c.req.query('filter') ?? 'all';
    const sort = c.req.query('sort') ?? 'attention';
    if (!['all', 'failing', 'passing', 'unrun'].includes(filter))
      return c.json({ error: 'bad filter' }, 400);
    if (!['attention', 'newest', 'oldest'].includes(sort))
      return c.json({ error: 'bad sort' }, 400);
    // Filter/rank predicates mirror ScenarioList's isFailing/isPassing
    // exactly — a verdict stored against a different config fingerprint is
    // stale and counts in neither bucket.
    const staleSql = sql`(${agentTests.configVersion} is not null and ${agentTests.configVersion} <> ${version})`;
    const freshSql = sql`(${agentTests.configVersion} is null or ${agentTests.configVersion} = ${version})`;
    const machinePassed = sql`(${agentTests.lastRun}->>'passed')::boolean`;
    const failingSql = sql`(${freshSql} and (${agentTests.humanResult} = 'fail' or (${agentTests.humanResult} is distinct from 'pass' and ${machinePassed} is false)))`;
    const passingSqlFrag = sql`(${freshSql} and (${agentTests.humanResult} = 'pass' or (${agentTests.humanResult} is distinct from 'fail' and ${machinePassed} is true)))`;
    const unrunSql = sql`${agentTests.lastRun} is null`;
    // Attention rank: failing first, then stale/never-run, then green —
    // the same triage order the list applies client-side when unpaged.
    const rankSql = sql`case when ${failingSql} then 0 when (${staleSql} or ${unrunSql}) then 1 else 2 end`;
    const filterSql =
      filter === 'failing' ? failingSql
      : filter === 'passing' ? passingSqlFrag
      : filter === 'unrun' ? unrunSql
      : sql`true`;
    // Keyset cursor: {r?, t, id} — rank only matters for attention order;
    // created_at ties break on id so a row never straddles two pages.
    type Cursor = { r?: number; t: string; id: string };
    let cursor: Cursor | null = null;
    const raw = c.req.query('cursor');
    if (raw) {
      try {
        cursor = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Cursor;
      } catch {
        return c.json({ error: 'bad cursor' }, 400);
      }
      if (typeof cursor.id !== 'string' || typeof cursor.t !== 'string')
        return c.json({ error: 'bad cursor' }, 400);
    }
    // cursor.t is created_at::text (full µs precision) — a JS Date would
    // truncate to ms and silently drop same-timestamp rows at page edges.
    const t = cursor?.t ?? '';
    const cursorSql = !cursor
      ? sql`true`
      : sort === 'attention'
        ? sql`(${rankSql} > ${cursor.r ?? 2} or (${rankSql} = ${cursor.r ?? 2} and ${agentTests.createdAt} < ${t}::timestamptz) or (${rankSql} = ${cursor.r ?? 2} and ${agentTests.createdAt} = ${t}::timestamptz and ${agentTests.id} < ${cursor.id}))`
        : sort === 'newest'
          ? sql`(${agentTests.createdAt} < ${t}::timestamptz or (${agentTests.createdAt} = ${t}::timestamptz and ${agentTests.id} < ${cursor.id}))`
          : sql`(${agentTests.createdAt} > ${t}::timestamptz or (${agentTests.createdAt} = ${t}::timestamptz and ${agentTests.id} > ${cursor.id}))`;
    const [rows, counts] = await Promise.all([
      db
        .select({ row: agentTests, rank: rankSql, ts: sql<string>`${agentTests.createdAt}::text` })
        .from(agentTests)
        .where(and(eq(agentTests.agentId, agent.id), filterSql, cursorSql))
        .orderBy(
          ...(sort === 'attention'
            ? [asc(rankSql), desc(agentTests.createdAt), desc(agentTests.id)]
            : sort === 'newest'
              ? [desc(agentTests.createdAt), desc(agentTests.id)]
              : [asc(agentTests.createdAt), asc(agentTests.id)]),
        )
        .limit(limit),
      db
        .select({
          all: sql<number>`count(*)::int`,
          failing: sql<number>`count(*) filter (where ${failingSql})::int`,
          passing: sql<number>`count(*) filter (where ${passingSqlFrag})::int`,
          unrun: sql<number>`count(*) filter (where ${unrunSql})::int`,
        })
        .from(agentTests)
        .where(eq(agentTests.agentId, agent.id)),
    ]);
    const last = rows.at(-1);
    const nextCursor =
      rows.length === limit && last
        ? Buffer.from(
            JSON.stringify({ r: last.rank, t: last.ts, id: last.row.id }),
          ).toString('base64url')
        : null;
    // Legacy saves carry internal audit rows ('Assigned to…', 'SLA breach…')
    // as turns — one batched mid lookup strips them from what the UI shows
    // as exchange context. Replays strip the same way inside runAgentTest.
    const allMids = [
      ...new Set(
        rows.flatMap(({ row }) =>
          ((row.turns ?? []) as { mid?: string }[])
            .map((t) => t.mid)
            .filter((m): m is string => !!m),
        ),
      ),
    ];
    const internalMids = new Set<string>();
    if (allMids.length) {
      const mrows = await db
        .select({ id: messages.id, direction: messages.direction, payload: messages.payload })
        .from(messages)
        .where(inArray(messages.id, allMids));
      for (const r of mrows)
        if (r.direction === 'out' && (r.payload as { internal?: boolean } | null)?.internal)
          internalMids.add(r.id);
    }
    const cleanTurns = (t: typeof agentTests.$inferSelect) =>
      internalMids.size
        ? ((t.turns ?? []) as { mid?: string }[]).filter((x) => !x.mid || !internalMids.has(x.mid))
        : t.turns;
    return c.json({
      tests: rows.map(({ row }) => toTest({ ...row, turns: cleanTurns(row) as never }, version)),
      config_version: version,
      next_cursor: nextCursor,
      counts: counts[0] ?? { all: 0, failing: 0, passing: 0, unrun: 0 },
    });
  });

  // Single-row read — powers "see matched scenario" jumps when the target
  // sits beyond the loaded pages (deep links, rail reveal, Fix-N-items).
  app.get('/:id/tests/:testId', agentMember, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const version = configVersion((agent.config ?? {}) as AgentConfig);
    const [t] = await db
      .select()
      .from(agentTests)
      .where(and(eq(agentTests.id, c.req.param('testId')), eq(agentTests.agentId, agent.id)))
      .limit(1);
    if (!t) return c.json({ error: 'not found' }, 404);
    return c.json({
      test: toTest(
        {
          ...t,
          turns: (await stripInternalTurns(db, (t.turns ?? []) as TestTurn[])) as never,
        },
        version,
      ),
    });
  });

  const TEST_CATEGORIES = ['safety', 'knowledge', 'actions', 'out_of_scope', 'tone', 'general'] as const;
  const TEST_SOURCES = ['generated', 'user', 'correction', 'transcript', 'inbox'] as const;
  const testBody = z.object({
    // Optional for the prompt shorthand — the trigger becomes the name.
    name: z.string().min(1).max(120).optional(),
    expectation: z.string().max(4000).default(''),
    turns: z
      .array(z.object({ role: z.enum(['customer', 'agent']), text: z.string().min(1) }))
      .max(60)
      .optional(),
    conversation_id: z.string().optional(),
    // Try-it scenario shorthand — a single-turn case saved from the panel
    // or a correction: prompt is the customer message that triggers it.
    prompt: z.string().min(1).max(400).optional(),
    // The reply that actually followed — inline saves carry it so the row
    // can show "what it said" like transcript checkpoints do.
    original_reply: z.string().max(4000).optional(),
    category: z.enum(TEST_CATEGORIES).optional(),
    source: z.enum(TEST_SOURCES).optional(),
  });

  app.post('/:id/tests', agentAdmin, zValidator('json', testBody), async (c) => {
    const agentId = c.req.param('id')!;
    const b = c.req.valid('json');
    let turns = b.turns ?? [];
    let sourceConversationId: string | null = null;
    let sourceConv: typeof conversations.$inferSelect | null = null;
    if (b.conversation_id) {
      const [conv] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, b.conversation_id), eq(conversations.agentId, agentId)))
        .limit(1);
      if (!conv) return c.json({ error: 'conversation not found' }, 404);
      sourceConversationId = conv.id;
      sourceConv = conv;
      if (!turns.length) {
        // A transcript with human rescues is several tests: one per customer
        // message that led to intervention — each replayed with the context
        // up to that point. No rescues → one test at the last customer turn.
        const full = await transcriptTurns(db, conv.id);
        const points = checkpointIndices(full);
        let lastCustomer = -1;
        for (let i = full.length - 1; i >= 0; i--) {
          if (full[i].role === 'customer') { lastCustomer = i; break; }
        }
        // Dedupe identical trigger prompts (keep the last occurrence — richest
        // context) and cap: a pathological transcript can yield dozens of
        // rescue points, and every test costs an LLM + judge call to run.
        const seen = new Map<string, number>();
        for (const p of points) seen.set(full[p].text.trim().toLowerCase(), p);
        const ends = points.length
          ? [...seen.values()].sort((a, b) => a - b).slice(-10)
          : lastCustomer >= 0 ? [lastCustomer] : [];
        if (!ends.length) return c.json({ error: 'no turns — supply turns or a conversation_id' }, 400);

        // Auto-draft expectations — a rescued conv creates judgeable tests
        // out of the box instead of rows waiting on a human write-up. Runs
        // in parallel (≤10 checkpoints), soft-fails to no expectation; the
        // expectation_draft flag marks them for review in the UI.
        let drafts: (string | null)[] = ends.map(() => null);
        if (!b.expectation) {
          const [agent] = await db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1);
          if (agent) {
            drafts = await Promise.all(
              ends.map((end) =>
                draftExpectation(
                  db,
                  agent,
                  full.slice(Math.max(0, end + 1 - 16), end + 1),
                  full[end + 1]?.text ?? null,
                ).catch(() => null),
              ),
            );
          }
        }

        // Replay context — each checkpoint's test hydrates with what the
        // live turn had: the triggering reply's tool calls (key → stored
        // result), the verified identity, and the conversation's profile/
        // channel/summary. One identity resolution + one message read for
        // the whole batch.
        const replyMids = [
          ...new Set(
            ends.map((e) => full[e + 1]?.mid).filter((m): m is string => !!m),
          ),
        ];
        const replyMsgs = replyMids.length
          ? await db
              .select({ id: messages.id, payload: messages.payload })
              .from(messages)
              .where(inArray(messages.id, replyMids))
          : [];
        const payloadByMid = new Map(replyMsgs.map((m) => [m.id, m.payload]));
        const replayIdentity = await verifiedIdentityFor(db, conv, c.get('workspaceId'));

        const rows = await db
          .insert(agentTests)
          .values(
            ends.map((end, i) => ({
              workspaceId: c.get('workspaceId'),
              agentId,
              name: ((b.name ?? full[end].text).slice(0, 120)) + (ends.length > 1 ? ` #${i + 1}` : ''),
              expectation: b.expectation || drafts[i] || '',
              expectationDraft: !b.expectation && !!drafts[i],
              turns: full.slice(Math.max(0, end + 1 - 16), end + 1) as never,
              sourceConversationId,
              sourceMessageId: full[end].mid ?? null,
              // what followed the trigger in the real transcript — usually the
              // agent's actual reply, or a marker like "(passed to a human…)"
              originalReply: full[end + 1]?.text ?? null,
              replayContext: replayContextFrom(
                conv,
                replayIdentity,
                payloadByMid.get(full[end + 1]?.mid ?? ''),
              ) as never,
            })),
          )
          .returning();
        return c.json({ test: toTest(rows[0]), tests: rows.map((t) => toTest(t)) }, 201);
      }
    }
    if (!turns.length && b.prompt) {
      turns = [{ role: 'customer' as const, text: b.prompt }];
    }
    if (!turns.length) return c.json({ error: 'no turns — supply turns or a conversation_id' }, 400);
    // Dedupe by meaning, not verbatim text: "are you a fan of cheese" IS
    // the "do you like cheese" scenario — fuzzy first, then one semantic
    // call when wording differs completely. Context-aware: the trigger
    // decides what the check IS; the setup decides whether it's THIS check
    // or a new one. Same trigger in a clearly different context becomes
    // its own scenario row; a bare-prompt save stays intent-level and
    // dedupes to whatever carries its trigger.
    const trigger = [...turns].reverse().find((t) => t.role === 'customer')?.text;
    if (trigger && !sourceConversationId) {
      const [agent, existing] = await Promise.all([
        db.select().from(agents).where(eq(agents.id, agentId)).limit(1).then((r) => r[0]),
        db
          .select()
          .from(agentTests)
          .where(eq(agentTests.agentId, agentId))
          .orderBy(desc(agentTests.createdAt)),
      ]);
      const turnsOf = (t: (typeof existing)[number]) => (t.turns ?? []) as MatchTurn[];
      const promptOf = (t: (typeof existing)[number]) => triggerOf(turnsOf(t)) || t.name;
      const exOf = (t: (typeof existing)[number]) =>
        formatExchange(
          turnsOf(t).length ? turnsOf(t) : [{ role: 'customer' as const, text: promptOf(t) }],
        );
      const queryCtx = contextOf(turns);
      const trigHits = existing.filter((t) => promptsSimilar(trigger, promptOf(t)));
      // A bare save scores compatible with everything — context can only
      // split scenarios when the new one actually carries some.
      const compatible = trigHits.filter(
        (t) => !queryCtx.length || contextScore(queryCtx, contextOf(turnsOf(t))) >= 0.3,
      );
      let hit: (typeof existing)[number] | null = null;
      let llmCands: typeof existing = [];
      if (compatible.length === 1) hit = compatible[0];
      else if (compatible.length > 1) llmCands = compatible; // several same-trigger checks — context picks
      else if (!trigHits.length) llmCands = existing; // paraphrase tier
      // else: every trigger match lives in a clearly different context —
      // that's a new scenario by definition, no LLM needed.
      if (!hit && llmCands.length && agent) {
        try {
          const idx = await matchPromptsSemantically(
            await llmFor(db, agent),
            [formatExchange(turns)],
            llmCands.map(exOf),
          );
          const j = idx[0];
          if (j != null) hit = llmCands[j];
        } catch {
          /* LLM unavailable — fall through to insert */
        }
      }
      if (hit) {
        const version = agent ? configVersion((agent.config ?? {}) as AgentConfig) : undefined;
        return c.json({ test: toTest(hit, version), deduped: true }, 200);
      }
    }
    // Turns were supplied so there's no identifiable reply message to pull
    // tool calls from — the snapshot still carries the identity + profile
    // the replayed prompt should see.
    const replayCtx = sourceConv
      ? replayContextFrom(
          sourceConv,
          await verifiedIdentityFor(db, sourceConv, c.get('workspaceId')),
          undefined,
        )
      : null;
    const [row] = await db
      .insert(agentTests)
      .values({
        workspaceId: c.get('workspaceId'),
        agentId,
        // Title = the exchange's subject (first substantive customer ask),
        // not the trigger — "928828" means nothing; "i need to return a
        // board i just bought" is the scenario's actual topic.
        name: (
          b.name ??
          b.prompt ??
          (turns as { role?: string; text?: string }[])
            .find((t) => t.role === 'customer' && (t.text ?? '').trim().length > 12)
            ?.text ??
          trigger ??
          'test'
        ).slice(0, 120),
        expectation: b.expectation,
        turns: turns as never,
        sourceConversationId,
        originalReply: b.original_reply ?? null,
        ...(replayCtx ? { replayContext: replayCtx as never } : {}),
        ...(b.category ? { category: b.category } : {}),
        ...(b.source ? { source: b.source } : {}),
      })
      .returning();
    return c.json({ test: toTest(row) }, 201);
  });

  // Which saved scenario (if any) each query hits — fuzzy resolves the
  // near-verbatim cases synchronously; stragglers get semantic calls.
  // Context-aware hybrid: one trigger match attaches instantly (no
  // per-message LLM); several same-trigger scenarios get disambiguated by
  // the query's context, escalating to a focused semantic call only when
  // word-overlap can't pick a winner. Queries may carry their own turn
  // window so "do you deliver?" in a Brooklyn vs Boston flow resolves to
  // different scenario rows.
  app.post(
    '/:id/tests/match',
    agentMember,
    zValidator(
      'json',
      z.object({
        queries: z
          .array(
            z.object({
              prompt: z.string().min(1).max(400),
              turns: z
                .array(z.object({ role: z.enum(['customer', 'agent']), text: z.string().min(1) }))
                .max(60)
                .optional(),
            }),
          )
          .min(1)
          .max(30),
      }),
    ),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const { queries } = c.req.valid('json');
      const rows = await db
        .select()
        .from(agentTests)
        .where(eq(agentTests.agentId, agent.id))
        .orderBy(desc(agentTests.createdAt));
      const turnsOf = (t: (typeof rows)[number]) => (t.turns ?? []) as MatchTurn[];
      const promptOf = (t: (typeof rows)[number]) => triggerOf(turnsOf(t)) || t.name;
      const exOf = (t: (typeof rows)[number]) =>
        formatExchange(
          turnsOf(t).length ? turnsOf(t) : [{ role: 'customer' as const, text: promptOf(t) }],
        );
      const qStr = (q: (typeof queries)[number]) =>
        q.turns?.length ? formatExchange(q.turns) : q.prompt;
      const matches: (string | null)[] = queries.map(() => null);
      const misses: number[] = []; // semantic over all rows
      const ambiguous: number[] = []; // semantic over that query's trigger hits
      for (const [i, q] of queries.entries()) {
        const hits = rows.filter((t) => promptsSimilar(q.prompt, promptOf(t)));
        if (hits.length === 1) matches[i] = hits[0].id;
        else if (!hits.length) misses.push(i);
        else {
          const ctx = contextOf((q.turns ?? []) as MatchTurn[]);
          let best: (typeof hits)[number] | null = null;
          let bestScore = 0.3;
          let tie = false;
          for (const t of hits) {
            const s = ctx.length ? contextScore(ctx, contextOf(turnsOf(t))) : 1;
            if (s > bestScore) {
              best = t;
              bestScore = s;
              tie = false;
            } else if (s === bestScore) tie = true;
          }
          if (best && !tie) matches[i] = best.id;
          else ambiguous.push(i);
        }
      }
      if ((misses.length || ambiguous.length) && rows.length) {
        try {
          const llm = await llmFor(db, agent);
          // One batched call for the paraphrase misses (whole list as
          // candidates); each ambiguous query gets a focused call against
          // only its same-trigger candidates — rare, so the loop is fine.
          if (misses.length) {
            const byIdx = await matchPromptsSemantically(
              llm,
              misses.map((i) => qStr(queries[i])),
              rows.map(exOf),
            );
            for (const [i, j] of Object.entries(byIdx)) {
              if (j != null) matches[misses[Number(i)]] = rows[j].id;
            }
          }
          for (const i of ambiguous.slice(0, 5)) {
            const hits = rows.filter((t) => promptsSimilar(queries[i].prompt, promptOf(t)));
            const byIdx = await matchPromptsSemantically(
              llm,
              [qStr(queries[i])],
              hits.map(exOf),
            );
            if (byIdx[0] != null) matches[i] = hits[byIdx[0]].id;
          }
        } catch {
          /* fuzzy results still returned */
        }
      }
      return c.json({ matches });
    },
  );

  app.patch(
    '/:id/tests/:testId',
    agentAdmin,
    zValidator(
      'json',
      testBody.partial().extend({
        // The panel-run verdict — human judgment, stored beside the
        // judge's machine verdict (last_run). Stamping the config version
        // at run time is what lets a later config edit mark this stale.
        // 'fixed_recheck' = a fix was applied post-fail and the scenario is
        // queued/rerunning — awaiting the re-verdict.
        human_result: z.enum(['pass', 'fail', 'unreviewed', 'fixed_recheck']).optional(),
        // Why a fail was judged wrong — set by the diagnose flow; null
        // clears it (e.g. a fresh pass).
        fail_cause: z.enum(['knowledge', 'behavior', 'ability', 'expectation']).nullable().optional(),
        // The reply a panel run just produced — merged into last_run so the
        // scenario row can show "what Janis answered" after a reload (panel
        // runs don't write last_run the way server replays do).
        last_reply: z.string().max(4000).optional(),
        // Save-and-re-check: judge the STORED reply against the (new)
        // expectation — deterministic and cheap; no fresh run means no
        // new random reply sneaks in to change the verdict.
        rejudge: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const b = c.req.valid('json');
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, c.req.param('id')))
        .limit(1);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const [prev] = b.last_reply !== undefined || b.rejudge
        ? await db
            .select()
            .from(agentTests)
            .where(
              and(eq(agentTests.id, c.req.param('testId')), eq(agentTests.agentId, agent.id)),
            )
            .limit(1)
        : [];
      // Re-check: the stored reply stands trial under the moved bar.
      let rejudged: { passed: boolean; reason: string } | undefined;
      const lastRun = prev?.lastRun as { reply?: string | null } | null | undefined;
      if (b.rejudge && lastRun?.reply) {
        const expectation = b.expectation ?? prev!.expectation ?? '';
        if (expectation.trim()) {
          const transcript = ((prev!.turns ?? []) as { role: string; text: string }[])
            .map((t) => `${t.role}: ${t.text}`)
            .join('\n');
          // A judge/LLM outage must not lose the expectation save — the
          // verdict just stays as it was.
          try {
            const llm = await llmFor(db, agent);
            const verdict = await judgeExpectation(llm, {
              transcript,
              reply: lastRun.reply,
              expectation,
            });
            if (verdict) {
              rejudged = { passed: verdict.pass, reason: verdict.reason };
              if (verdict.promptTokens || verdict.completionTokens) {
                await recordLlmUsage(db, {
                  workspaceId: agent.workspaceId,
                  agentId: agent.id,
                  conversationId: prev!.sourceConversationId,
                  model: verdict.model,
                  capModel: llm.model,
                  promptTokens: verdict.promptTokens,
                  completionTokens: verdict.completionTokens,
                  byok: llm.byok,
                });
              }
            }
          } catch {
            /* judged stays whatever it was */
          }
        }
      }
      const [row] = await db
        .update(agentTests)
        .set({
          ...(b.name !== undefined ? { name: b.name } : {}),
          // editing the draft is the review — clears the AI-draft marker
          ...(b.expectation !== undefined
            ? { expectation: b.expectation, expectationDraft: false }
            : {}),
          ...(b.turns !== undefined ? { turns: b.turns as never } : {}),
          ...(b.category !== undefined ? { category: b.category } : {}),
          ...(b.human_result !== undefined
            ? {
                humanResult: b.human_result,
                humanRunAt: new Date(),
                configVersion: configVersion((agent.config ?? {}) as AgentConfig),
                // A pass clears the recorded cause — a fail/fixed_recheck
                // keeps the one the diagnose flow set unless overridden.
                ...(b.human_result === 'pass' ? { failCause: null } : {}),
              }
            : {}),
          ...(b.fail_cause !== undefined ? { failCause: b.fail_cause } : {}),
          ...(b.last_reply !== undefined || rejudged
            ? {
                lastRun: {
                  ...((prev?.lastRun as Record<string, unknown> | null) ?? {}),
                  ...(b.last_reply !== undefined ? { reply: b.last_reply } : {}),
                  ...(rejudged
                    ? { passed: rejudged.passed, reason: rejudged.reason }
                    : {}),
                  at: new Date().toISOString(),
                } as never,
              }
            : {}),
        })
        .where(and(eq(agentTests.id, c.req.param('testId')), eq(agentTests.agentId, c.req.param('id'))))
        .returning();
      if (!row) return c.json({ error: 'not found' }, 404);
      return c.json({ test: toTest(row, configVersion((agent.config ?? {}) as AgentConfig)) });
    },
  );

  // Re-draft an AI-written expectation — drafts written before the drafter
  // learned the sim's limits ask for things a replay can't produce (a real
  // human acting, ETAs, out-of-band status). The rewrite lands flagged as a
  // draft again, and the stored reply is re-judged against the new bar so
  // the verdict updates without spending a fresh run.
  app.post('/:id/tests/:testId/expectation-redraft', agentAdmin, async (c) => {
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, c.req.param('id')))
      .limit(1);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const [test] = await db
      .select()
      .from(agentTests)
      .where(and(eq(agentTests.id, c.req.param('testId')), eq(agentTests.agentId, agent.id)))
      .limit(1);
    if (!test) return c.json({ error: 'not found' }, 404);
    const turns = await stripInternalTurns(db, (test.turns ?? []) as TestTurn[]);
    const draft = await draftExpectation(db, agent, turns, test.originalReply ?? null);
    if (!draft) return c.json({ error: 'draft failed — check the agent has a working LLM' }, 502);

    let rejudged: { passed: boolean; reason: string } | undefined;
    const lastRun = test.lastRun as { reply?: string | null } | null;
    if (lastRun?.reply) {
      try {
        const llm = await llmFor(db, agent);
        const verdict = await judgeExpectation(llm, {
          transcript: turns.map((t) => `${t.role}: ${t.text}`).join('\n'),
          reply: lastRun.reply,
          expectation: draft,
        });
        if (verdict) {
          rejudged = { passed: verdict.pass, reason: verdict.reason };
          if (verdict.promptTokens || verdict.completionTokens) {
            await recordLlmUsage(db, {
              workspaceId: agent.workspaceId,
              agentId: agent.id,
              conversationId: test.sourceConversationId,
              model: verdict.model,
              capModel: llm.model,
              promptTokens: verdict.promptTokens,
              completionTokens: verdict.completionTokens,
              byok: llm.byok,
            });
          }
        }
      } catch {
        /* a judge/LLM outage must not lose the redraft — verdict stays */
      }
    }
    const [row] = await db
      .update(agentTests)
      .set({
        expectation: draft,
        // still machine-written — the draft badge stays until a human edits
        expectationDraft: true,
        ...(rejudged
          ? {
              lastRun: {
                ...((test.lastRun as Record<string, unknown> | null) ?? {}),
                passed: rejudged.passed,
                reason: rejudged.reason,
                at: new Date().toISOString(),
              } as never,
            }
          : {}),
      })
      .where(eq(agentTests.id, test.id))
      .returning();
    return c.json({ test: toTest(row, configVersion((agent.config ?? {}) as AgentConfig)) });
  });

  // Audit the rule surface for contradictions — the concierge miss that
  // motivated this: "flag for a human when asked" sat next to "manual
  // intervention → sign in via Copilot" for weeks, and only a failing test
  // noticed. Optional {instructions, tone} lets the editor check in-flight
  // text against the saved knowledge/procedures instead of what's deployed.
  app.post(
    '/:id/prompt-check',
    agentAdmin,
    zValidator(
      'json',
      z.object({
        instructions: z.string().max(20_000).optional(),
        tone: z.string().max(2000).optional(),
      }),
    ),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const conflicts = await checkPromptConflicts(db, agent, c.req.valid('json'));
      if (conflicts === null) return c.json({ error: 'check failed — check the agent has a working LLM' }, 502);
      return c.json({ conflicts });
    },
  );

  // Draft fresh scenario candidates from the agent's CURRENT state — the
  // builder's creation-time scenarios predate the knowledge base and any
  // instruction edits, so this is the "things changed — what should we be
  // testing now" pass. Returns drafts for review; the client materializes
  // the accepted ones through POST /:id/tests (source 'generated').
  app.post('/:id/tests-generate', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const suggestions = await generateScenarioDrafts(db, agent);
    if (suggestions === null) return c.json({ error: 'generation failed' }, 502);
    return c.json({ suggestions });
  });

  // Materialize the draft's suggested_scenarios as test rows — the Try it
  // checklist. Idempotent: a prompt that already exists (any source) is
  // skipped, so a re-draft refreshes suggestions without overwriting
  // user-written or correction-saved cases.
  app.post('/:id/tests-seed', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const cfg = (agent.config ?? {}) as AgentConfig;
    const suggested = cfg.builder?.suggested_scenarios ?? [];
    if (!suggested.length) return c.json({ created: 0 });
    const existing = await db
      .select({ turns: agentTests.turns })
      .from(agentTests)
      .where(eq(agentTests.agentId, agent.id));
    const seen = new Set(
      existing
        .map((r) => (r.turns as { role: string; text: string }[])?.[0]?.text?.trim().toLowerCase())
        .filter(Boolean),
    );
    const fresh = suggested.filter((s) => !seen.has(s.prompt.trim().toLowerCase()));
    if (!fresh.length) return c.json({ created: 0 });
    const rows = await db
      .insert(agentTests)
      .values(
        fresh.map((s) => ({
          workspaceId: c.get('workspaceId'),
          agentId: agent.id,
          name: s.prompt.slice(0, 120),
          expectation: s.expected,
          turns: [{ role: 'customer' as const, text: s.prompt }] as never,
          category: s.category,
          source: 'generated',
        })),
      )
      .returning();
    return c.json({ created: rows.length, tests: rows.map((t) => toTest(t)) });
  });

  // DELETE /:id/tests?source=<conversationId> — remove a whole saved batch at
  // once; the Tests tab groups a split transcript's tests under one card.
  app.delete('/:id/tests', agentAdmin, async (c) => {
    const source = c.req.query('source');
    if (!source) return c.json({ error: 'source=<conversation_id> required' }, 400);
    const rows = await db
      .delete(agentTests)
      .where(
        and(
          eq(agentTests.agentId, c.req.param('id')),
          eq(agentTests.sourceConversationId, source),
        ),
      )
      .returning({ id: agentTests.id });
    return c.json({ deleted: rows.length });
  });

  app.delete('/:id/tests/:testId', agentAdmin, async (c) => {
    const [row] = await db
      .delete(agentTests)
      .where(and(eq(agentTests.id, c.req.param('testId')), eq(agentTests.agentId, c.req.param('id'))))
      .returning({ id: agentTests.id });
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  // Replay one test — runs the real pipeline in testRun mode: no tool call
  // executes, gated calls are only proposed, nothing reaches a customer.
  app.post('/:id/tests/:testId/run', agentMember, async (c) => {
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, c.req.param('id')))
      .limit(1);
    if (!agent?.hosted) return c.json({ error: 'tests replay through the hosted agent' }, 400);
    const [test] = await db
      .select()
      .from(agentTests)
      .where(and(eq(agentTests.id, c.req.param('testId')), eq(agentTests.agentId, agent.id)))
      .limit(1);
    if (!test) return c.json({ error: 'not found' }, 404);
    const run = await runAgentTest(db, agent, test);
    await recordRun(db, {
      agent,
      test,
      result: run,
      batchId: randomUUID(),
      kind: 'manual',
    });
    const [updated] = await db
      .update(agentTests)
      .set({
        lastRun: run as never,
        configVersion: configVersion((agent.config ?? {}) as AgentConfig),
        // The verdict judged the previous reply — a new replay needs a
        // fresh human look.
        humanResult: null,
      })
      .where(eq(agentTests.id, test.id))
      .returning();
    return c.json({ test: toTest(updated), run });
  });

  // Bulk import — CSV of "name, customer prompt, expectation" rows. Each
  // becomes a single-turn test. For multi-turn suites, save from a real
  // conversation instead.
  app.post('/:id/tests-import', agentAdmin, zValidator('json', z.object({
    csv: z.string().min(1).max(500_000),
  })), async (c) => {
    const agentId = c.req.param('id')!;
    const rows = parseCsv(c.req.valid('json').csv).filter(
      (r) => r.length >= 2 && r[1].trim(),
    );
    if (!rows.length) return c.json({ error: 'no rows — expected "name, prompt, expectation" (name optional)' }, 400);
    if (rows.length > 200) return c.json({ error: 'max 200 rows per import' }, 400);
    // Header row detection: skip it if the first cell looks like a header.
    if (['name', 'test', 'title'].includes(rows[0][0].trim().toLowerCase())) rows.shift();
    const inserted = await db
      .insert(agentTests)
      .values(
        rows.map((r) => ({
          workspaceId: c.get('workspaceId'),
          agentId,
          // Name is a display label only — blank falls back to the prompt,
          // the same default inline scenario saves use.
          name: (r[0].trim() || r[1].trim()).slice(0, 120),
          expectation: (r[2] ?? '').trim().slice(0, 4000),
          turns: [{ role: 'customer', text: r[1].trim() }] as never,
        })),
      )
      .returning({ id: agentTests.id });
    return c.json({ imported: inserted.length }, 201);
  });

  // Run every saved case — the "did my prompt/KB change regress anything" gate.
  // Optional {system_prompt} replays the suite against a candidate prompt
  // (A/B experiment) — nothing is saved back to the agent config.
  app.post('/:id/tests-run-all', agentMember, async (c) => {
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, c.req.param('id')))
      .limit(1);
    if (!agent?.hosted) return c.json({ error: 'tests replay through the hosted agent' }, 400);
    // Optional body — an empty POST is the baseline run. {system_prompt} and/or
    // {model} replay the suite against a candidate config (A/B experiment,
    // model comparison) — nothing is saved back to the agent config.
    const raw = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        system_prompt: z.string().max(20_000).optional(),
        model: z.string().min(1).max(200).optional(),
      })
      .safeParse(raw);
    const candidate = parsed.success ? parsed.data.system_prompt : undefined;
    const candidateModel = parsed.success ? parsed.data.model : undefined;
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(agentTests)
      .where(eq(agentTests.agentId, agent.id));
    const batchId = randomUUID();
    const kind = candidate !== undefined || candidateModel !== undefined ? 'ab' : 'manual';
    // Suites run N×(generate+judge) LLM calls — far past the request timeout.
    // Offload to the jobs path (same drain the scheduled evals use); the
    // client polls /test-runs for batch rows as they land.
    await enqueueJob(db, {
      workspaceId: agent.workspaceId,
      type: 'eval.suite',
      payload: {
        agentId: agent.id,
        batchId,
        kind,
        runOpts: {
          ...(candidate !== undefined ? { systemPrompt: candidate } : {}),
          ...(candidateModel !== undefined ? { model: candidateModel } : {}),
        },
      },
    });
    // Kick the drain — the claim is SKIP LOCKED so an in-process pass racing
    // the sweeper tick can't double-run it; this just removes tick latency.
    void runJobs(db);
    return c.json({ batch_id: batchId, total }, 202);
  });

  // Rescued-but-untested conversations: scan recent convs for human-rescue
  // markers (failure/help_requested/custom_alert flags, or a non-internal
  // operator reply) that have NO saved test — the suggestion list on the
  // Tests tab. Dismissed convs live in config.dismissed_test_suggestions.
  app.get('/:id/test-suggestions', agentMember, async (c) => {
    const agentId = c.req.param('id')!;
    const [agent] = await db
      .select({ config: agents.config })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const dismissed = new Set(
      ((agent.config as { dismissed_test_suggestions?: string[] } | null)
        ?.dismissed_test_suggestions ?? []),
    );

    const raw = (await db.execute(sql`
      select m.conversation_id as conv_id,
             count(*)::int as rescues,
             max(m.created_at) as last_rescue
      from messages m
      join conversations cv on cv.id = m.conversation_id
      where cv.agent_id = ${agentId}
        and cv.created_at > now() - interval '30 days'
        and (
          coalesce((m.flags->>'failure')::boolean, false)
          or coalesce((m.flags->>'help_requested')::boolean, false)
          or coalesce((m.flags->>'custom_alert')::boolean, false)
          or (m.direction = 'human'
              and coalesce((m.payload->>'internal')::boolean, false) = false)
        )
      group by m.conversation_id
      order by max(m.created_at) desc
      limit 25
    `)) as unknown;
    const flagged = ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows) ?? []) as {
      conv_id: string;
      rescues: number;
      last_rescue: string;
    }[];
    if (!flagged.length) return c.json({ suggestions: [] });

    const covered = await db
      .select({ convId: agentTests.sourceConversationId })
      .from(agentTests)
      .where(
        and(
          eq(agentTests.agentId, agentId),
          inArray(agentTests.sourceConversationId, flagged.map((f) => f.conv_id)),
        ),
      );
    const coveredIds = new Set(covered.map((r) => r.convId).filter(Boolean));

    const open = flagged.filter((f) => !coveredIds.has(f.conv_id) && !dismissed.has(f.conv_id));
    if (!open.length) return c.json({ suggestions: [] });

    const convs = await db
      .select({
        id: conversations.id,
        externalId: conversations.externalId,
        userProfile: conversations.userProfile,
        lastMessageAt: conversations.lastMessageAt,
        lastMessagePreview: conversations.lastMessagePreview,
      })
      .from(conversations)
      .where(inArray(conversations.id, open.map((f) => f.conv_id)));
    const byId = new Map(convs.map((cv) => [cv.id, cv]));

    return c.json({
      suggestions: open
        .map((f) => {
          const cv = byId.get(f.conv_id);
          if (!cv) return null;
          const name =
            (cv.userProfile as { name?: string } | undefined)?.name ??
            friendlyName(cv.externalId);
          return {
            conversation_id: f.conv_id,
            name,
            preview: cv.lastMessagePreview,
            rescues: f.rescues,
            last_rescue: f.last_rescue,
          };
        })
        .filter(Boolean)
        .slice(0, 10),
    });
  });

  // Run history — recent batches newest-first, each with its per-test
  // verdicts. Powers the tests tab's history view and regression diffs.
  app.get('/:id/test-runs', agentMember, async (c) => {
    const rows = await db
      .select()
      .from(agentTestRuns)
      .where(eq(agentTestRuns.agentId, c.req.param('id')))
      .orderBy(desc(agentTestRuns.createdAt))
      .limit(600);
    const batches = new Map<
      string,
      {
        batch_id: string;
        kind: string;
        at: string;
        passed: number;
        failed: number;
        unrunnable: number;
        results: { test_id: string; name: string; passed: boolean | null; reason: string; model: string | null; reply: string | null }[];
      }
    >();
    for (const r of rows) {
      let b = batches.get(r.batchId);
      if (!b) {
        b = {
          batch_id: r.batchId,
          kind: r.kind,
          at: r.createdAt.toISOString(),
          passed: 0,
          failed: 0,
          unrunnable: 0,
          results: [],
        };
        batches.set(r.batchId, b);
      }
      if (r.passed === true) b.passed++;
      else if (r.passed === false) b.failed++;
      else b.unrunnable++;
      b.results.push({
        test_id: r.testId,
        name: r.testName,
        passed: r.passed,
        reason: r.reason,
        model: r.model,
        reply: r.reply?.slice(0, 4000) ?? null,
      });
    }
    return c.json({ batches: [...batches.values()].slice(0, 30) });
  });

  // Regression-triage suggestions — eval.triage classified a regressed batch's
  // flips, drafted fixes, and verified the applicable ones by replaying the
  // suite. The Tests tab lists pending rows; apply writes the patch to the
  // agent config (knowledge append / prompt append / expectation rewrite).
  app.get('/:id/eval-suggestions', agentMember, async (c) => {
    const rows = await db
      .select()
      .from(evalSuggestions)
      .where(
        and(
          eq(evalSuggestions.agentId, c.req.param('id')),
          eq(evalSuggestions.status, 'pending'),
        ),
      )
      .orderBy(desc(evalSuggestions.createdAt))
      .limit(20);
    const testNames = new Map(
      (
        await db
          .select({ id: agentTests.id, name: agentTests.name })
          .from(agentTests)
          .where(eq(agentTests.agentId, c.req.param('id')))
      ).map((t) => [t.id, t.name]),
    );
    return c.json({
      suggestions: rows.map((r) => ({
        id: r.id,
        batch_id: r.batchId,
        test_id: r.testId,
        test_name: r.testId ? (testNames.get(r.testId) ?? null) : null,
        kind: r.kind,
        summary: r.summary,
        patch: r.patch,
        verified: r.verified,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  const decideSuggestion = (status: 'applied' | 'dismissed') =>
    app.post('/:id/eval-suggestions/:sid/' + (status === 'applied' ? 'apply' : 'dismiss'), agentAdmin, async (c) => {
      const agentId = c.req.param('id')!;
      const [suggestion] = await db
        .select()
        .from(evalSuggestions)
        .where(
          and(
            eq(evalSuggestions.id, c.req.param('sid')!),
            eq(evalSuggestions.agentId, agentId),
            eq(evalSuggestions.workspaceId, c.get('workspaceId')),
          ),
        )
        .limit(1);
      if (!suggestion || suggestion.status !== 'pending')
        return c.json({ error: 'not found' }, 404);
      if (status === 'applied') {
        const [agent] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, agentId))
          .limit(1);
        if (!agent) return c.json({ error: 'not found' }, 404);
        if (!suggestion.patch) return c.json({ error: 'nothing to apply — hypothesis only' }, 400);
        const ok = await applySuggestion(db, agent, suggestion.patch as SuggestionPatch);
        if (!ok) return c.json({ error: 'patch target no longer exists' }, 409);
      }
      await db
        .update(evalSuggestions)
        .set({ status })
        .where(eq(evalSuggestions.id, suggestion.id));
      return c.json({ ok: true });
    });
  decideSuggestion('applied');
  decideSuggestion('dismissed');

  return app;
}

/** Minimal CSV reader — quoted fields, escaped quotes, CRLF. Good enough for
 *  the "name, prompt, expectation" sheet ops teams export from anywhere. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  const push = () => {
    row.push(field);
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && !field.trim()) {
      field = '';
      quoted = true;
    } else if (ch === ',') {
      push();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      push();
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) {
    push();
    rows.push(row);
  }
  return rows;
}

/** Insert or rotate an agent secret. Returns an error string on the cap. */
async function upsertAgentSecret(
  db: Db,
  agentId: string,
  workspaceId: string,
  name: string,
  value: string,
): Promise<string | null> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentSecrets)
    .where(eq(agentSecrets.agentId, agentId));
  const [existing] = await db
    .select({ id: agentSecrets.id })
    .from(agentSecrets)
    .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.name, name)))
    .limit(1);
  if (!existing && count >= 50) return 'secret limit reached (50)';
  const valueEnc = encryptSecret(value);
  if (existing) {
    await db
      .update(agentSecrets)
      .set({ valueEnc, updatedAt: new Date() })
      .where(eq(agentSecrets.id, existing.id));
  } else {
    await db.insert(agentSecrets).values({ workspaceId, agentId, name, valueEnc });
  }
  return null;
}
