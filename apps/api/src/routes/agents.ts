import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { AgentConfig, friendlyName } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, agentConnections, agentMembers, agentSecrets, agentTests, agentTestRuns, agentWidgets, alertRules, alerts, channelBindings, channels, conversations, evalSuggestions, knowledgeFiles, memberships, messages, pendingActions, savedReplies, slackInstallations, slackThreads, suggestions, usageEvents, users, webhookDeliveries, workspaces } from '../db/schema.js';
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
import { bus } from '../lib/bus.js';
import { env } from '../env.js';
import { deliverWebhook, replayDelivery } from '../lib/webhooks.js';
import { extractKnowledgeText, UnsupportedFileError } from '../lib/knowledge.js';
import { fetchUrlText, refreshKnowledgeSource } from '../lib/urlSource.js';
import { importHelpCentre, MAX_KNOWLEDGE_SOURCES } from '../lib/helpCentreImport.js';
import {
  detectKnowledgeGaps,
  draftKnowledgeEntry,
  gapsCacheFresh,
  listLearnNotes,
  markGapsAdded,
  readGapsCache,
  recheckGaps,
} from '../services/knowledgeGaps.js';
import { encryptSecret } from '../lib/secrets.js';
import { llmFor } from '../lib/hostedAgent.js';
import { checkpointIndices, draftExpectation, runAgentTest, transcriptTurns } from '../lib/agentTests.js';
import { recordRun } from '../lib/evalRuns.js';
import { applySuggestion, type SuggestionPatch } from '../lib/evalTriage.js';
import { randomUUID } from 'node:crypto';
import { effectiveMeteredModel } from '../lib/llm.js';
import { llmModelsResult } from '../lib/llmModels.js';
import { agentRoleFor, agentScopeCond, isAdminRole } from '../lib/access.js';
import { effectivePlanKey } from '../lib/plans.js';
import { processEvents } from '../services/ingest.js';
import { toAgent } from '../lib/serializers.js';
import { audit } from '../lib/audit.js';
import { invalidateChannelCache } from '../lib/channels.js';
import { TOOL_TEMPLATES } from '../lib/toolTemplates.js';
import { connectionToken } from '../lib/connections.js';
import {
  createSlackChannel,
  getInstallation,
  inviteWorkspaceMembers,
  sanitizeChannelName,
  slackChannelInfo,
} from '../lib/slack.js';

const createAgent = z.object({
  name: z.string().min(1).max(120),
  webhook_url: z.string().url().optional(),
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
      .orderBy(desc(agents.createdAt));
    return c.json({ agents: rows.map(toAgent) });
  });

  app.post('/', adminOnly, zValidator('json', createAgent), async (c) => {
    const body = c.req.valid('json');
    // Agency children ride on the parent's plan but can't grow the fleet —
    // new agents need a subscription of their own (or the parent's help).
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
    if (ws?.parentWorkspaceId && !ws.stripeSubscriptionId && !ws.connectSubscriptionId) {
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
    }
    const [row] = await db
      .insert(agents)
      .values({
        workspaceId: c.get('workspaceId'),
        ownerUserId: c.get('user').id,
        name: body.name,
        // no API key until the operator generates one — hosted agents never call /v1
        webhookSecret: generateWebhookSecret(),
        webhookUrl: body.webhook_url ?? null,
        hosted: body.hosted ?? false,
        autoResumeMinutes: body.auto_resume_minutes ?? 10,
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
    return c.json({ agent: toAgent(row) }, 201);
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
    }
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
    if (!(await ownedAgent(c))) return c.json({ error: 'not found' }, 404);
    const rows = await db
      .select()
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.agentId, c.req.param('id')))
      .orderBy(desc(knowledgeFiles.createdAt));
    return c.json({
      files: rows.map((r) => ({
        id: r.id,
        name: r.name,
        mime_type: r.mimeType,
        size_bytes: r.sizeBytes,
        chars: r.text.length,
        status: r.status,
        error: r.error,
        source_url: r.sourceUrl,
        refresh_hours: r.refreshHours,
        last_fetched_at: r.lastFetchedAt?.toISOString() ?? null,
        next_fetch_at: r.nextFetchAt?.toISOString() ?? null,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

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
  const urlBody = z.object({
    url: z.string().url().max(2000),
    refresh_hours: z.number().int().min(1).max(24 * 30).default(24),
  });
  app.post('/:id/knowledge-url', agentAdmin, zValidator('json', urlBody), async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const { url, refresh_hours } = c.req.valid('json');
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(knowledgeFiles)
      .where(eq(knowledgeFiles.agentId, agent.id));
    if (count >= MAX_KNOWLEDGE_SOURCES)
      return c.json({ error: `knowledge file limit reached (${MAX_KNOWLEDGE_SOURCES})` }, 409);
    let fetched: { text: string; sizeBytes: number };
    try {
      fetched = await fetchUrlText(url);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'fetch failed' }, 422);
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
        sourceUrl: url,
        refreshHours: refresh_hours,
        lastFetchedAt: now,
        nextFetchAt: new Date(now.getTime() + refresh_hours * 3600_000),
      })
      .returning();
    return c.json({ file: { id: row.id } }, 201);
  });

  // Whole-centre import — paste a help centre root and we fan it out into
  // per-article URL sources. Zendesk centres fill rows inline from the
  // articles API; everything else falls back to the sitemap and the
  // sweeper's bounded re-crawl fills the stub rows.
  app.post('/:id/knowledge-import', agentAdmin, zValidator('json', urlBody), async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const { url, refresh_hours } = c.req.valid('json');
    try {
      const result = await importHelpCentre(
        db,
        c.get('workspaceId'),
        agent.id,
        url,
        refresh_hours,
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
    return c.json({ gaps: cache.gaps, learnings, computed_at: cache.at });
  });

  // Force a fresh detection run — the operator's "Refresh" button.
  app.post('/:id/knowledge-gaps/refresh', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const cache = await computeAndCacheGaps(agent);
    return c.json({ gaps: cache.gaps, computed_at: cache.at });
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
      const missing = tpl.fields.filter((f) => !fields[f.key]?.trim()).map((f) => f.label);
      if (missing.length) return c.json({ error: `missing: ${missing.join(', ')}` }, 400);

      // OAuth templates: store the credentials and mint a token now so a bad
      // client_id/secret fails at connect time, not during a conversation.
      if (tpl.connection) {
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
      return c.json({ agent: toAgent(updated) });
    },
  );

  // Per-tool approval gates on an installed template — the UI's checkboxes.
  // Matches tools by name so installs predating the `template` marker still
  // get managed (and get stamped on write).
  app.patch(
    '/:id/tools/:template', agentAdmin,
    zValidator(
      'json',
      z.object({ approvals: z.record(z.string(), z.boolean()) }),
    ),
    async (c) => {
      const agent = await ownedAgent(c);
      if (!agent) return c.json({ error: 'not found' }, 404);
      const tpl = TOOL_TEMPLATES.find((t) => t.id === c.req.param('template'));
      if (!tpl) return c.json({ error: 'unknown template' }, 404);
      const { approvals } = c.req.valid('json');
      const names = new Set(tpl.tools.map((t) => t.name));
      const cfg = (agent.config ?? {}) as AgentConfig;
      const tools = (cfg.tools ?? []).map((t) =>
        names.has(t.name) && approvals[t.name] !== undefined
          ? { ...t, template: tpl.id, approval: approvals[t.name] || undefined }
          : t,
      );
      const [updated] = await db
        .update(agents)
        .set({ config: { ...cfg, tools } })
        .where(eq(agents.id, agent.id))
        .returning();
      return c.json({ agent: toAgent(updated) });
    },
  );

  // Remove a template's tools; secrets stay (they may be shared with custom tools).
  app.delete('/:id/tools/:template', agentAdmin, async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const tpl = TOOL_TEMPLATES.find((t) => t.id === c.req.param('template'));
    if (!tpl) return c.json({ error: 'unknown template' }, 404);
    if (tpl.connection) {
      await db
        .delete(agentConnections)
        .where(
          and(
            eq(agentConnections.agentId, agent.id),
            eq(agentConnections.provider, tpl.connection.provider),
          ),
        );
    }
    const cfg = (agent.config ?? {}) as AgentConfig;
    const names = new Set(tpl.tools.map((t) => t.name));
    const tools = (cfg.tools ?? []).filter((t) => !names.has(t.name));
    const [updated] = await db
      .update(agents)
      .set({ config: { ...cfg, tools } })
      .where(eq(agents.id, agent.id))
      .returning();
    return c.json({ agent: toAgent(updated) });
  });

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
        spec: spec.data,
        states: body.states ?? null,
        tool: body.tool ?? null,
        autoGreet: !!body.auto_greet,
      })
      .onConflictDoUpdate({
        target: [agentWidgets.agentId, agentWidgets.name],
        set: {
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

  app.delete('/:id/knowledge/:fileId', agentAdmin, async (c) => {
    if (!(await ownedAgent(c))) return c.json({ error: 'not found' }, 404);
    const [row] = await db
      .delete(knowledgeFiles)
      .where(
        and(eq(knowledgeFiles.id, c.req.param('fileId')), eq(knowledgeFiles.agentId, c.req.param('id'))),
      )
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  app.delete('/:id', agentAdmin, async (c) => {
    const agentId = c.req.param('id');
    const workspaceId = c.get('workspaceId');
    // No ON DELETE CASCADE in the schema — remove dependent rows leaf-first.
    const convIds = (
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.agentId, agentId))
    ).map((r) => r.id);
    const chanIds = (
      await db.select({ id: channels.id }).from(channels).where(eq(channels.agentId, agentId))
    ).map((r) => r.id);
    const [row] = await db.transaction(async (tx) => {
      // Rows keyed by agent that also hold conv/message refs go first.
      await tx.delete(pendingActions).where(eq(pendingActions.agentId, agentId));
      await tx.delete(usageEvents).where(eq(usageEvents.agentId, agentId));
      if (convIds.length) {
        await tx.delete(alerts).where(inArray(alerts.conversationId, convIds));
        await tx.delete(suggestions).where(inArray(suggestions.conversationId, convIds));
        await tx.delete(slackThreads).where(inArray(slackThreads.conversationId, convIds));
        await tx.delete(channelBindings).where(inArray(channelBindings.conversationId, convIds));
        await tx.delete(messages).where(inArray(messages.conversationId, convIds));
        await tx.delete(conversations).where(inArray(conversations.id, convIds));
      }
      if (chanIds.length) {
        await tx.delete(channelBindings).where(inArray(channelBindings.channelId, chanIds));
        await tx.delete(channels).where(inArray(channels.id, chanIds));
      }
      await tx.delete(agentTests).where(eq(agentTests.agentId, agentId));
      await tx.delete(knowledgeFiles).where(eq(knowledgeFiles.agentId, agentId));
      await tx.delete(savedReplies).where(eq(savedReplies.agentId, agentId));
      await tx.delete(alertRules).where(eq(alertRules.agentId, agentId));
      await tx.delete(agentSecrets).where(eq(agentSecrets.agentId, agentId));
      await tx.delete(agentConnections).where(eq(agentConnections.agentId, agentId));
      await tx.delete(agentMembers).where(eq(agentMembers.agentId, agentId));
      await tx.delete(webhookDeliveries).where(eq(webhookDeliveries.agentId, agentId));
      return tx
        .delete(agents)
        .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
        .returning();
    });
    if (!row) return c.json({ error: 'not found' }, 404);
    await audit(db, {
      workspaceId,
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'agent.delete',
      targetType: 'agent',
      targetId: agentId,
    });
    return c.json({ ok: true });
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
      // a hidden row would contradict ownership — clear it back to inherit
      await db
        .update(agentMembers)
        .set({ role: null })
        .where(
          and(
            eq(agentMembers.agentId, c.req.param('id')),
            eq(agentMembers.userId, targetId),
            eq(agentMembers.role, 'hidden'),
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

  const toTest = (t: typeof agentTests.$inferSelect) => ({
    id: t.id,
    name: t.name,
    turns: t.turns,
    expectation: t.expectation,
    expectation_draft: t.expectationDraft,
    source_conversation_id: t.sourceConversationId,
    source_message_id: t.sourceMessageId,
    original_reply: t.originalReply,
    last_run: t.lastRun,
    created_at: t.createdAt.toISOString(),
  });

  app.get('/:id/tests', agentMember, async (c) => {
    const rows = await db
      .select()
      .from(agentTests)
      .where(eq(agentTests.agentId, c.req.param('id')))
      .orderBy(asc(agentTests.createdAt));
    return c.json({ tests: rows.map(toTest) });
  });

  const testBody = z.object({
    name: z.string().min(1).max(120),
    expectation: z.string().max(4000).default(''),
    turns: z
      .array(z.object({ role: z.enum(['customer', 'agent']), text: z.string().min(1) }))
      .max(60)
      .optional(),
    conversation_id: z.string().optional(),
  });

  app.post('/:id/tests', agentAdmin, zValidator('json', testBody), async (c) => {
    const agentId = c.req.param('id')!;
    const b = c.req.valid('json');
    let turns = b.turns ?? [];
    let sourceConversationId: string | null = null;
    if (b.conversation_id) {
      const [conv] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, b.conversation_id), eq(conversations.agentId, agentId)))
        .limit(1);
      if (!conv) return c.json({ error: 'conversation not found' }, 404);
      sourceConversationId = conv.id;
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

        const rows = await db
          .insert(agentTests)
          .values(
            ends.map((end, i) => ({
              workspaceId: c.get('workspaceId'),
              agentId,
              name: ends.length > 1 ? `${b.name} #${i + 1}` : b.name,
              expectation: b.expectation || drafts[i] || '',
              expectationDraft: !b.expectation && !!drafts[i],
              turns: full.slice(Math.max(0, end + 1 - 16), end + 1) as never,
              sourceConversationId,
              sourceMessageId: full[end].mid ?? null,
              // what followed the trigger in the real transcript — usually the
              // agent's actual reply, or a marker like "(passed to a human…)"
              originalReply: full[end + 1]?.text ?? null,
            })),
          )
          .returning();
        return c.json({ test: toTest(rows[0]), tests: rows.map(toTest) }, 201);
      }
    }
    if (!turns.length) return c.json({ error: 'no turns — supply turns or a conversation_id' }, 400);
    const [row] = await db
      .insert(agentTests)
      .values({
        workspaceId: c.get('workspaceId'),
        agentId,
        name: b.name,
        expectation: b.expectation,
        turns: turns as never,
        sourceConversationId,
      })
      .returning();
    return c.json({ test: toTest(row) }, 201);
  });

  app.patch('/:id/tests/:testId', agentAdmin, zValidator('json', testBody.partial()), async (c) => {
    const b = c.req.valid('json');
    const [row] = await db
      .update(agentTests)
      .set({
        ...(b.name !== undefined ? { name: b.name } : {}),
        // editing the draft is the review — clears the AI-draft marker
        ...(b.expectation !== undefined
          ? { expectation: b.expectation, expectationDraft: false }
          : {}),
        ...(b.turns !== undefined ? { turns: b.turns as never } : {}),
      })
      .where(and(eq(agentTests.id, c.req.param('testId')), eq(agentTests.agentId, c.req.param('id'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ test: toTest(row) });
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
      .set({ lastRun: run as never })
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
      (r) => r.length >= 2 && r[0].trim() && r[1].trim(),
    );
    if (!rows.length) return c.json({ error: 'no rows — expected "name, prompt, expectation"' }, 400);
    if (rows.length > 200) return c.json({ error: 'max 200 rows per import' }, 400);
    // Header row detection: skip it if the first cell looks like a header.
    if (['name', 'test', 'title'].includes(rows[0][0].trim().toLowerCase())) rows.shift();
    const inserted = await db
      .insert(agentTests)
      .values(
        rows.map((r) => ({
          workspaceId: c.get('workspaceId'),
          agentId,
          name: r[0].trim().slice(0, 120),
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
    const rows = await db
      .select()
      .from(agentTests)
      .where(eq(agentTests.agentId, agent.id))
      .orderBy(asc(agentTests.createdAt));
    const batchId = randomUUID();
    const isExperiment = candidate !== undefined || candidateModel !== undefined;
    const kind = isExperiment ? 'ab' : 'manual';
    const results: { id: string; name: string; passed: boolean | null; reason: string }[] = [];
    for (const test of rows) {
      // An unrunnable candidate (bad model id, unpriced metered model, key
      // failure) shouldn't kill the whole batch — mark the test unrunnable.
      const run = await runAgentTest(db, agent, test, isExperiment
        ? {
            ...(candidate !== undefined ? { systemPrompt: candidate } : {}),
            ...(candidateModel !== undefined ? { model: candidateModel } : {}),
          }
        : undefined
      ).catch((e) => ({
        at: new Date().toISOString(),
        passed: null,
        reply: null,
        tools: [],
        model: candidateModel,
        reason: e instanceof Error ? e.message : 'run failed',
      }));
      await recordRun(db, { agent, test, result: run, batchId, kind });
      // Candidate runs are experiments — don't overwrite the baseline's verdict.
      if (!isExperiment) {
        await db.update(agentTests).set({ lastRun: run as never }).where(eq(agentTests.id, test.id));
      }
      results.push({ id: test.id, name: test.name, passed: run.passed, reason: run.reason });
    }
    return c.json({
      results,
      summary: {
        passed: results.filter((r) => r.passed === true).length,
        failed: results.filter((r) => r.passed === false).length,
        unrunnable: results.filter((r) => r.passed === null).length,
      },
    });
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
        results: { test_id: string; name: string; passed: boolean | null; reason: string; model: string | null }[];
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
