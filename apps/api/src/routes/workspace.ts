import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { meteredModelOf, type LlmConfigBlock } from '../lib/llm.js';
import { llmModelsResult } from '../lib/llmModels.js';
import { effectivePlanKey } from '../lib/plans.js';
import { scrubLlmBlock } from '../lib/serializers.js';
import {
  agents,
  alertRules,
  alerts,
  channelBindings,
  channels,
  conversations,
  digests,
  knowledgeFiles,
  agentSecrets,
  memberships,
  messages,
  metaConnections,
  savedReplies,
  sessions,
  slackInstallations,
  slackThreads,
  suggestions,
  usageEvents,
  webhookDeliveries,
  workspaces,
} from '../db/schema.js';
import { stripe } from '../lib/stripe.js';
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
        id: ws.id,
        name: ws.name,
        llm_config: scrubLlmBlock(ws.llmConfig),
        event_webhook_url:
          (ws.config as { event_webhook_url?: string } | undefined)?.event_webhook_url ?? null,
        help_domain:
          (ws.config as { help_domain?: string } | undefined)?.help_domain ?? null,
        send_policy: (ws.config as { send_policy?: unknown } | undefined)?.send_policy ?? null,
        event_token:
          (ws.config as { event_token?: string } | undefined)?.event_token ?? null,
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
      body.send_policy !== undefined
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
    return c.json({
      workspace: {
        id: ws.id,
        name: ws.name,
        llm_config: scrubLlmBlock(ws.llmConfig),
        event_webhook_url:
          (ws.config as { event_webhook_url?: string } | undefined)?.event_webhook_url ?? null,
        help_domain:
          (ws.config as { help_domain?: string } | undefined)?.help_domain ?? null,
        send_policy: (ws.config as { send_policy?: unknown } | undefined)?.send_policy ?? null,
        event_token:
          (ws.config as { event_token?: string } | undefined)?.event_token ?? null,
      },
    });
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

    const agentIds = (
      await db.select({ id: agents.id }).from(agents).where(eq(agents.workspaceId, workspaceId))
    ).map((r) => r.id);
    const convIds = agentIds.length
      ? (
          await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(inArray(conversations.agentId, agentIds))
        ).map((r) => r.id)
      : [];
    // (users are workspace-independent now — memberships, not user rows, go)

    if (convIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, convIds));
      await db.delete(alerts).where(inArray(alerts.conversationId, convIds));
      await db.delete(suggestions).where(inArray(suggestions.conversationId, convIds));
      await db.delete(slackThreads).where(inArray(slackThreads.conversationId, convIds));
      await db.delete(channelBindings).where(inArray(channelBindings.conversationId, convIds));
    }
    // usage_events reference agents + conversations — gone before them
    await db.delete(usageEvents).where(eq(usageEvents.workspaceId, workspaceId));
    if (convIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, convIds));
    }
    if (agentIds.length) {
      await db.delete(alertRules).where(inArray(alertRules.agentId, agentIds));
      await db.delete(knowledgeFiles).where(inArray(knowledgeFiles.agentId, agentIds));
      await db.delete(agentSecrets).where(inArray(agentSecrets.agentId, agentIds));
      await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.agentId, agentIds));
    }
    await db.delete(channels).where(eq(channels.workspaceId, workspaceId));
    if (agentIds.length) {
      await db.delete(agents).where(inArray(agents.id, agentIds));
    }
    // slack_installations.installer_user_id references users — before them
    await db.delete(slackInstallations).where(eq(slackInstallations.workspaceId, workspaceId));
    await db.delete(metaConnections).where(eq(metaConnections.workspaceId, workspaceId));
    await db.delete(savedReplies).where(eq(savedReplies.workspaceId, workspaceId));
    await db.delete(digests).where(eq(digests.workspaceId, workspaceId));
    // user rows survive — they may hold memberships elsewhere. Only the
    // workspace's memberships and the sessions pointed at it go.
    await db.delete(memberships).where(eq(memberships.workspaceId, workspaceId));
    await db.delete(sessions).where(eq(sessions.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));

    return c.json({ ok: true });
  });

  return app;
}
