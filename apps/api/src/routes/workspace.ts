import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { meteredModelOf, type LlmConfigBlock } from '../lib/llm.js';
import { llmModelsResult } from '../lib/llmModels.js';
import { effectivePlanKey } from '../lib/plans.js';
import { scrubLlmBlock } from '../lib/serializers.js';
import {
  agents,
  agentTestRuns,
  analyticsEvents,
  campaigns,
  campaignSends,
  contactLists,
  contacts,
  conversionEvents,
  conversations,
  crmActivityQueue,
  crmConnections,
  digests,
  errorReports,
  evalSuggestions,
  formSubmissions,
  memberGroups,
  memberships,
  metaConnections,
  pendingActions,
  savedReplies,
  savedViews,
  sessions,
  slackInstallations,
  suppressions,
  usageEvents,
  workspaces,
} from '../db/schema.js';
import { deleteAgentsCascade } from '../lib/agentCleanup.js';
import { stripe } from '../lib/stripe.js';
import {
  listConnections,
  listDirectories,
  maybeDisableSso,
  createOrganization,
  portalLink,
  readWorkosState,
  SSO_PLANS,
} from '../lib/workos.js';
import { audit, auditLogFor } from '../lib/audit.js';
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';

const updateWorkspace = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  // Outbound event export — Zapier/Make catch hook that receives every
  // inbound message + handoff as a JSON POST. null clears it.
  event_webhook_url: z.string().url().max(2000).nullable().optional(),
  // Custom help-center domain (help.acme.com) — the workspace CNAMEs it to
  // app.janis.ai and /api/help/domain resolves the host back to this
  // workspace's published articles. null clears it.
  help_domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/, 'must be a bare domain like help.acme.com')
    .max(200)
    .nullable()
    .optional(),
  // Bulk-send guardrails — quiet hours in an IANA zone + a rolling-24h
  // per-recipient cap. Applies to marketing-class sends only (campaigns,
  // broadcasts); conversational replies are never throttled.
  send_policy: z
    .object({
      quiet_enabled: z.boolean().optional(),
      quiet_from: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
      quiet_to: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
      quiet_tz: z.string().max(60).optional(),
      max_per_recipient_per_day: z.number().int().min(1).max(1000).nullable().optional(),
    })
    .nullable()
    .optional(),
  // Workspace-wide CSAT survey defaults — agents inherit unless their own
  // config.csat overrides a field. null clears the whole block.
  csat: z
    .object({
      enabled: z.boolean().optional(),
      prompt: z.string().max(500).optional(),
      thanks: z.string().max(500).optional(),
    })
    .nullable()
    .optional(),
  // Workspace default for the resolution flow — agents inherit unless their
  // own config.auto_archive overrides. null clears the key.
  auto_archive: z.boolean().nullable().optional(),
  // Workspace default for human escalation — false steers agents away from
  // offering/requesting a human (they resolve or say they can't). Agents
  // inherit unless their own config.handoff_enabled overrides.
  handoff_enabled: z.boolean().nullable().optional(),
  // Conversation data retention — conversations idle longer than this many
  // days are permanently deleted (transcripts carry customer PII). null =
  // keep forever. Enforced by the retention sweeper.
  data_retention_days: z.number().int().min(7).max(3650).nullable().optional(),
  llm_config: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      base_url: z.string().optional(),
      api_key: z.string().nullable().optional(),
      effort: z.string().optional(),
      key_set: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

type WorkspaceRow = typeof workspaces.$inferSelect;

/** Shared response shape for GET and PATCH — retention includes the
 *  blast-radius count (conversations the policy would delete today). */
async function workspaceView(db: Db, ws: WorkspaceRow) {
  const days = (ws.config as { data_retention_days?: number } | undefined)
    ?.data_retention_days;
  let expiring: number | null = null;
  if (typeof days === 'number' && days > 0) {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentId, agents.id))
      .where(
        and(
          eq(agents.workspaceId, ws.id),
          lt(
            sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`,
            // ISO string, not the Date — postgres-js can't serialize Date
            // params inside raw sql`` fragments (ERR_INVALID_ARG_TYPE).
            cutoff.toISOString(),
          ),
        ),
      );
    expiring = row?.n ?? 0;
  }
  return {
    id: ws.id,
    name: ws.name,
    llm_config: scrubLlmBlock(ws.llmConfig),
    event_webhook_url:
      (ws.config as { event_webhook_url?: string } | undefined)?.event_webhook_url ?? null,
    help_domain:
      (ws.config as { help_domain?: string } | undefined)?.help_domain ?? null,
    send_policy: (ws.config as { send_policy?: unknown } | undefined)?.send_policy ?? null,
    csat: (ws.config as { csat?: unknown } | undefined)?.csat ?? null,
    auto_archive:
      (ws.config as { auto_archive?: boolean } | undefined)?.auto_archive ?? null,
    handoff_enabled:
      (ws.config as { handoff_enabled?: boolean } | undefined)?.handoff_enabled ?? null,
    event_token:
      (ws.config as { event_token?: string } | undefined)?.event_token ?? null,
    data_retention_days: days ?? null,
    retention_expiring_count: expiring,
  };
}

export function workspaceRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // GET /api/workspace — id/name plus the workspace default LLM block
  // (api_key scrubbed to key_set, same contract as agent config).
  app.get('/', async (c) => {
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, c.get('workspaceId')))
      .limit(1);
    if (!ws) return c.json({ error: 'not found' }, 404);
    return c.json({
      workspace: {
        ...(await workspaceView(db, ws)),
        plan: await effectivePlanKey(db, ws.id),
      },
    });
  });

  // POST /api/workspace/event-token — mint/rotate the credential authorizing
  // POST /events/:token conversions. Rotating invalidates the old URL.
  app.post('/event-token', adminOnly, async (c) => {
    const workspaceId = c.get('workspaceId');
    const token = randomBytes(24).toString('base64url');
    const [ws] = await db
      .select({ config: workspaces.config })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const config = {
      ...((ws?.config ?? {}) as Record<string, unknown>),
      event_token: token,
    };
    await db.update(workspaces).set({ config }).where(eq(workspaces.id, workspaceId));
    await audit(db, {
      workspaceId,
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'workspace.event_token.rotate',
      targetType: 'workspace',
      targetId: workspaceId,
    });
    return c.json({ event_token: token });
  });

  // PATCH /api/workspace — admin only. llm_config is the default every agent
  // inherits; an agent's own config.llm overrides it field-wise. The api_key
  // merge matches the agent PATCH: undefined/'' keeps the stored key, null
  // clears, a real string replaces. Free plan can't move the metered model.
  app.patch('/', adminOnly, zValidator('json', updateWorkspace), async (c) => {
    const workspaceId = c.get('workspaceId');
    const body = c.req.valid('json');
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!ws) return c.json({ error: 'not found' }, 404);
    await audit(db, {
      workspaceId,
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'workspace.update',
      targetType: 'workspace',
      targetId: workspaceId,
      meta: { fields: Object.keys(body) },
    });

    if (body.name !== undefined) {
      await db
        .update(workspaces)
        .set({ name: body.name })
        .where(eq(workspaces.id, workspaceId));
      ws.name = body.name;
    }
    if (
      body.event_webhook_url !== undefined ||
      body.help_domain !== undefined ||
      body.send_policy !== undefined ||
      body.csat !== undefined ||
      body.auto_archive !== undefined ||
      body.handoff_enabled !== undefined ||
      body.data_retention_days !== undefined
    ) {
      const config = {
        ...(ws.config as Record<string, unknown>),
        ...(body.event_webhook_url ? { event_webhook_url: body.event_webhook_url } : {}),
        ...(body.help_domain ? { help_domain: body.help_domain } : {}),
      };
      if (body.event_webhook_url === null || body.event_webhook_url === '')
        delete (config as Record<string, unknown>).event_webhook_url;
      if (body.help_domain === null || body.help_domain === '')
        delete (config as Record<string, unknown>).help_domain;
      if (body.send_policy === null) delete (config as Record<string, unknown>).send_policy;
      else if (body.send_policy !== undefined)
        (config as Record<string, unknown>).send_policy = body.send_policy;
      if (body.csat === null) delete (config as Record<string, unknown>).csat;
      else if (body.csat !== undefined)
        (config as Record<string, unknown>).csat = {
          ...(((config as Record<string, unknown>).csat ?? {}) as Record<string, unknown>),
          ...body.csat,
        };
      if (body.auto_archive === null)
        delete (config as Record<string, unknown>).auto_archive;
      else if (body.auto_archive !== undefined)
        (config as Record<string, unknown>).auto_archive = body.auto_archive;
      if (body.handoff_enabled === null)
        delete (config as Record<string, unknown>).handoff_enabled;
      else if (body.handoff_enabled !== undefined)
        (config as Record<string, unknown>).handoff_enabled = body.handoff_enabled;
      if (body.data_retention_days === null)
        delete (config as Record<string, unknown>).data_retention_days;
      else if (body.data_retention_days !== undefined)
        (config as Record<string, unknown>).data_retention_days = body.data_retention_days;
      await db.update(workspaces).set({ config }).where(eq(workspaces.id, workspaceId));
      ws.config = config;
    }
    if (body.llm_config === null) {
      await db.update(workspaces).set({ llmConfig: {} }).where(eq(workspaces.id, workspaceId));
      return c.json({ workspace: { id: ws.id, name: ws.name, llm_config: {} } });
    }
    if (body.llm_config !== undefined) {
      const storedKey =
        (((ws.llmConfig ?? {}) as LlmConfigBlock).api_key as string) ?? '';
      const { key_set: _ignored, ...llm } = body.llm_config;
      const next = { ...llm } as LlmConfigBlock;
      if (next.api_key === null) delete next.api_key;
      else if (!next.api_key) next.api_key = storedKey || undefined;

      const after = meteredModelOf({ llm: next });
      if (after !== null) {
        const before = meteredModelOf({ llm: ws.llmConfig });
        if (
          after !== before &&
          after !== env.llmModel &&
          (await effectivePlanKey(db, workspaceId)) === 'free'
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
      await db
        .update(workspaces)
        .set({ llmConfig: next })
        .where(eq(workspaces.id, workspaceId));
      return c.json({
        workspace: { id: ws.id, name: ws.name, llm_config: scrubLlmBlock(next) },
      });
    }
    return c.json({ workspace: await workspaceView(db, ws) });
  });

  // GET /api/workspace/audit-log — admin only. Every security/billing
  // mutation writes a row; this is the queryable trail (SOC 2 prerequisite).
  app.get('/audit-log', adminOnly, async (c) => {
    const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
    return c.json({ entries: await auditLogFor(db, c.get('workspaceId'), limit) });
  });

  // POST /api/workspace/llm-models — same model-listing contract as the
  // agent endpoint, with the workspace's stored key filling in when the
  // endpoint matches what's saved.
  app.post(
    '/llm-models',
    adminOnly,
    zValidator(
      'json',
      z.object({
        base_url: z.string().optional(),
        api_key: z.string().optional(),
        metered: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const [ws] = await db
        .select({ llmConfig: workspaces.llmConfig })
        .from(workspaces)
        .where(eq(workspaces.id, c.get('workspaceId')))
        .limit(1);
      const r = await llmModelsResult(
        ((ws?.llmConfig ?? {}) as LlmConfigBlock) ?? {},
        c.req.valid('json'),
      );
      return c.json(r.body, r.status as 200 | 400);
    },
  );


  // ---- Enterprise SSO (WorkOS AuthKit) -----------------------------------
  // Scale/internal plan-gated: each connection bills ~$125/mo against OUR
  // WorkOS account, so only gated tiers may mint Admin Portal links. The
  // workspace→WorkOS mapping lives in config.workos {organization_id,
  // domain, connection_id}; the SCIM webhook resolves workspaces via
  // config.workos_directory_id.
  const ssoConfig = async (workspaceId: string) => {
    const [ws] = await db
      .select({ config: workspaces.config, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return { ws, state: readWorkosState(ws?.config) };
  };

  // GET /api/workspace/sso — status for the Settings card. Polls WorkOS for
  // connection/directory state and self-heals the stored ids (the portal
  // flow happens entirely on WorkOS's side — this is how we learn it finished).
  app.get('/sso', adminOnly, async (c) => {
    const workspaceId = c.get('workspaceId');
    const { ws, state } = await ssoConfig(workspaceId);
    if (!ws) return c.json({ error: 'not found' }, 404);
    const plan = await effectivePlanKey(db, workspaceId);
    const out: Record<string, unknown> = {
      configured: Boolean(env.workosClientId && env.workosApiKey),
      allowed: SSO_PLANS.has(plan),
      plan,
      domain: state.domain ?? null,
      organization_id: state.organization_id ?? null,
      connection_status: null,
      directory_linked: false,
      signin_url: state.domain
        ? `${env.webOrigin.replace(/\/$/, '')}/login?sso_domain=${encodeURIComponent(state.domain)}`
        : null,
    };
    if (!env.workosApiKey || !state.organization_id) return c.json({ sso: out });
    try {
      const [conns, dirs] = await Promise.all([
        listConnections(state.organization_id),
        listDirectories(state.organization_id),
      ]);
      const active = conns.find((x) => x.status === 'active');
      const dir = dirs.find((d) => d.state !== 'unlinked' && d.state !== 'inactive') ?? dirs[0];
      out.connection_status = active ? 'active' : (conns[0]?.status ?? 'pending_setup');
      out.directory_linked = Boolean(dir);
      const config = { ...((ws.config ?? {}) as Record<string, unknown>) };
      let touched = false;
      if (active && state.connection_id !== active.id) {
        config.workos = { ...state, connection_id: active.id };
        touched = true;
      }
      if (dir && config.workos_directory_id !== dir.id) {
        config.workos_directory_id = dir.id;
        touched = true;
      }
      if (touched) {
        await db.update(workspaces).set({ config }).where(eq(workspaces.id, workspaceId));
      }
    } catch (e) {
      out.workos_error = e instanceof Error ? e.message : String(e);
    }
    return c.json({ sso: out });
  });

  // POST /api/workspace/sso/setup {domain, intent} — create the WorkOS
  // organization on first use and mint an Admin Portal link ('sso' for the
  // SAML wizard, 'dsync' for directory provisioning). The customer completes
  // setup on WorkOS's side; GET /sso picks the result up on next load.
  app.post(
    '/sso/setup',
    adminOnly,
    zValidator(
      'json',
      z.object({
        domain: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'enter a bare domain like acme.com'),
        intent: z.enum(['sso', 'dsync']).default('sso'),
      }),
    ),
    async (c) => {
      if (!env.workosApiKey) return c.json({ error: 'SSO is not configured on this deployment' }, 400);
      const workspaceId = c.get('workspaceId');
      const plan = await effectivePlanKey(db, workspaceId);
      if (!SSO_PLANS.has(plan)) {
        return c.json({ error: 'SSO requires the Scale plan', plan }, 403);
      }
      const { domain, intent } = c.req.valid('json');
      const { ws, state } = await ssoConfig(workspaceId);
      if (!ws) return c.json({ error: 'not found' }, 404);
      try {
        let organizationId = state.organization_id;
        if (!organizationId) {
          const org = await createOrganization(ws.name || `Workspace ${workspaceId.slice(0, 8)}`, domain);
          organizationId = org.id;
          const config = { ...((ws.config ?? {}) as Record<string, unknown>) };
          config.workos = { ...state, organization_id: organizationId, domain };
          await db.update(workspaces).set({ config }).where(eq(workspaces.id, workspaceId));
        } else if (domain !== state.domain) {
          // Domain change mid-setup — the portal link still targets the org;
          // the stored label follows what the admin last requested.
          const config = { ...((ws.config ?? {}) as Record<string, unknown>) };
          config.workos = { ...state, domain };
          await db.update(workspaces).set({ config }).where(eq(workspaces.id, workspaceId));
        }
        const { link } = await portalLink(organizationId, intent);
        await audit(db, {
          workspaceId,
          userId: c.get('user').id,
          userName: c.get('user').name,
          action: 'workspace.sso.portal_link',
          targetType: 'workspace',
          targetId: workspaceId,
          meta: { domain, intent, organization_id: organizationId },
        });
        return c.json({ portal_url: link });
      } catch (e) {
        return c.json({ error: `WorkOS: ${e instanceof Error ? e.message : e}` }, 502);
      }
    },
  );

  // POST /api/workspace/sso/disable — delete the WorkOS connection (stops
  // the per-connection meter) and clear the stored mapping.
  app.post('/sso/disable', adminOnly, async (c) => {
    const workspaceId = c.get('workspaceId');
    await maybeDisableSso(db, workspaceId);
    await audit(db, {
      workspaceId,
      userId: c.get('user').id,
      userName: c.get('user').name,
      action: 'workspace.sso.disable',
      targetType: 'workspace',
      targetId: workspaceId,
    });
    return c.json({ ok: true });
  });

  // DELETE /api/workspace — permanently remove the workspace and every row
  // attached to it (no FK cascades, so children go first). Admin only.
  app.delete('/', adminOnly, async (c) => {
    const workspaceId = c.get('workspaceId');
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!ws) return c.json({ error: 'not found' }, 404);

    // stop the meter before deleting — an active sub would keep billing
    if (ws.stripeSubscriptionId) {
      const s = stripe();
      if (s) {
        try {
          await s.subscriptions.cancel(ws.stripeSubscriptionId);
        } catch {
          // already canceled/gone on Stripe's side
        }
      }
    }
    // same for a WorkOS SSO connection — it bills $125/mo until deleted
    await maybeDisableSso(db, workspaceId);

    const agentIds = (
      await db.select({ id: agents.id }).from(agents).where(eq(agents.workspaceId, workspaceId))
    ).map((r) => r.id);
    // Every agent-keyed dependent — the shared cascade (conversations,
    // channels, tests, widgets, shopify bindings, …) walked leaf-first.
    // Missing tables here used to 500 the delete on FK violations.
    await deleteAgentsCascade(db, agentIds);
    // Workspace-scoped rows the agent cascade doesn't cover — including
    // ws-keyed rows whose agent link is null (workspace saved replies,
    // concierge pending actions) and tables with no agent column at all.
    await db.delete(usageEvents).where(eq(usageEvents.workspaceId, workspaceId));
    await db.delete(pendingActions).where(eq(pendingActions.workspaceId, workspaceId));
    await db.delete(evalSuggestions).where(eq(evalSuggestions.workspaceId, workspaceId));
    await db.delete(formSubmissions).where(eq(formSubmissions.workspaceId, workspaceId));
    await db.delete(agentTestRuns).where(eq(agentTestRuns.workspaceId, workspaceId));
    await db.delete(campaignSends).where(eq(campaignSends.workspaceId, workspaceId));
    await db.delete(campaigns).where(eq(campaigns.workspaceId, workspaceId));
    // contacts before contact_lists — members cascade on either parent.
    await db.delete(contacts).where(eq(contacts.workspaceId, workspaceId));
    await db.delete(contactLists).where(eq(contactLists.workspaceId, workspaceId));
    await db.delete(memberGroups).where(eq(memberGroups.workspaceId, workspaceId));
    await db.delete(conversionEvents).where(eq(conversionEvents.workspaceId, workspaceId));
    await db.delete(crmActivityQueue).where(eq(crmActivityQueue.workspaceId, workspaceId));
    await db.delete(crmConnections).where(eq(crmConnections.workspaceId, workspaceId));
    await db.delete(analyticsEvents).where(eq(analyticsEvents.workspaceId, workspaceId));
    await db.delete(errorReports).where(eq(errorReports.workspaceId, workspaceId));
    await db.delete(savedViews).where(eq(savedViews.workspaceId, workspaceId));
    await db.delete(suppressions).where(eq(suppressions.workspaceId, workspaceId));
    await db.delete(agents).where(inArray(agents.id, agentIds));
    // slack_installations.installer_user_id references users — before them
    await db.delete(slackInstallations).where(eq(slackInstallations.workspaceId, workspaceId));
    await db.delete(metaConnections).where(eq(metaConnections.workspaceId, workspaceId));
    await db.delete(savedReplies).where(eq(savedReplies.workspaceId, workspaceId));
    await db.delete(digests).where(eq(digests.workspaceId, workspaceId));
    // user rows survive — they may hold memberships elsewhere. Only the
    // workspace's memberships and the sessions pointed at it go.
    await db.delete(memberships).where(eq(memberships.workspaceId, workspaceId));
    await db.delete(sessions).where(eq(sessions.workspaceId, workspaceId));
    // Agency children lose the parent link — the FK restricts otherwise.
    await db
      .update(workspaces)
      .set({ parentWorkspaceId: null })
      .where(eq(workspaces.parentWorkspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));

    return c.json({ ok: true });
  });

  return app;
}
