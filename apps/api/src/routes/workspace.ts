import { Hono } from 'hono';
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
import { adminOnly, sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';

const updateWorkspace = z.object({
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
      },
    });
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
      workspace: { id: ws.id, name: ws.name, llm_config: scrubLlmBlock(ws.llmConfig) },
    });
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
