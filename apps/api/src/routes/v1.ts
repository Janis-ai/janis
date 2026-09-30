import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { IngestRequest } from '@janis/shared';
import type { Db } from '../db/client.js';
import { channels, conversations } from '../db/schema.js';
import { agentAuth, type AgentAuthEnv } from '../middleware/agentAuth.js';
import { deliverWebhook } from '../lib/webhooks.js';
import { bus } from '../lib/bus.js';
import { sendCsatPrompt } from '../lib/csat.js';
import { sendOutbound } from '../lib/outbound.js';
import { toConversation } from '../lib/serializers.js';
import { processEvents } from '../services/ingest.js';
import { storeSuggestion } from '../services/suggestions.js';

/**
 * Agent-facing API. Auth: `Authorization: Bearer <agent api key>`.
 */
export function v1Routes(db: Db) {
  const app = new Hono<AgentAuthEnv>();
  app.use('/*', agentAuth(db));

  // Batch ingest — the SDK's single entry point
  app.post('/events', zValidator('json', IngestRequest), async (c) => {
    const agent = c.get('agent');
    const { events } = c.req.valid('json');
    const results = await processEvents(db, agent, events);
    return c.json({ results });
  });

  // Polling fallback for agents that can't receive webhooks
  app.get('/conversations/:externalId/state', async (c) => {
    const agent = c.get('agent');
    const [conv] = await db
      .select({ state: conversations.state })
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, agent.id),
          eq(conversations.externalId, c.req.param('externalId')),
        ),
      )
      .limit(1);
    if (!conv) return c.json({ error: 'not found' }, 404);
    return c.json({ state: conv.state, paused: conv.state === 'human' });
  });

  // Agent answers a suggestion.request webhook with its drafted reply
  app.post(
    '/suggestions',
    zValidator(
      'json',
      z.object({
        conversation_id: z.string(),
        text: z.string().min(1),
        notes: z.string().max(500).optional(),
      }),
    ),
    async (c) => {
      const agent = c.get('agent');
      const { conversation_id, text, notes } = c.req.valid('json');
      const [conv] = await db
        .select()
        .from(conversations)
        .where(
          and(eq(conversations.agentId, agent.id), eq(conversations.externalId, conversation_id)),
        )
        .limit(1);
      if (!conv) return c.json({ error: 'conversation not found' }, 404);
      const row = await storeSuggestion(db, conv.id, text, 'agent', notes);
      return c.json({ suggestion: { id: row.id } }, 201);
    },
  );

  // Agent's behavior config — polled by template-based agents at runtime
  app.get('/config', (c) => {
    const agent = c.get('agent');
    return c.json({ config: agent.config ?? {} });
  });

  // Agent identity — Zapier's auth-test + connection label endpoint
  app.get('/me', (c) => {
    const agent = c.get('agent');
    return c.json({ id: agent.id, name: agent.name });
  });

  // Conversation list — Zapier polling trigger. Newest first; ?state= filters
  // (e.g. needs_human for an escalation trigger). `id` is the dedup key.
  app.get('/conversations', async (c) => {
    const agent = c.get('agent');
    const state = c.req.query('state');
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 100);
    const conds = [eq(conversations.agentId, agent.id)];
    if (state) {
      conds.push(
        eq(
          conversations.state,
          state as (typeof conversations.state.enumValues)[number],
        ),
      );
    }
    const rows = await db
      .select()
      .from(conversations)
      .where(and(...conds))
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(limit);
    return c.json(rows.map((r) => toConversation(r)));
  });

  const convFor = async (agentId: string, externalId: string) => {
    const [conv] = await db
      .select()
      .from(conversations)
      .where(
        and(eq(conversations.agentId, agentId), eq(conversations.externalId, externalId)),
      )
      .limit(1);
    return conv;
  };

  // Reply to an existing conversation — stored + delivered through its channel.
  app.post(
    '/conversations/:externalId/reply',
    zValidator('json', z.object({ text: z.string().min(1) })),
    async (c) => {
      const agent = c.get('agent');
      const externalId = c.req.param('externalId');
      if (!(await convFor(agent.id, externalId)))
        return c.json({ error: 'conversation not found' }, 404);
      const { text } = c.req.valid('json');
      const [result] = await processEvents(db, agent, [
        { type: 'message_out', conversation_id: externalId, text },
      ]);
      return c.json({ conversation_id: externalId, state: result.conversation_state });
    },
  );

  // Escalate → needs_human (open alert, Slack/console notification).
  app.post(
    '/conversations/:externalId/escalate',
    zValidator('json', z.object({ reason: z.string().max(500).optional() }).optional()),
    async (c) => {
      const agent = c.get('agent');
      const externalId = c.req.param('externalId');
      if (!(await convFor(agent.id, externalId)))
        return c.json({ error: 'conversation not found' }, 404);
      const reason = c.req.valid('json')?.reason;
      const [result] = await processEvents(db, agent, [
        { type: 'handoff_request', conversation_id: externalId, ...(reason ? { reason } : {}) },
      ]);
      return c.json({ conversation_id: externalId, state: result.conversation_state });
    },
  );

  // Resume → handoff_cancelled clears a needs_human flag back to active.
  app.post('/conversations/:externalId/resume', async (c) => {
    const agent = c.get('agent');
    const externalId = c.req.param('externalId');
    if (!(await convFor(agent.id, externalId)))
      return c.json({ error: 'conversation not found' }, 404);
    const [result] = await processEvents(db, agent, [
      { type: 'handoff_cancelled', conversation_id: externalId },
    ]);
    return c.json({ conversation_id: externalId, state: result.conversation_state });
  });

  // Resolve → archived, with the same one-shot CSAT prompt the console sends.
  app.post('/conversations/:externalId/resolve', async (c) => {
    const agent = c.get('agent');
    const externalId = c.req.param('externalId');
    const conv = await convFor(agent.id, externalId);
    if (!conv) return c.json({ error: 'conversation not found' }, 404);
    if (conv.state === 'archived') return c.json({ conversation_id: externalId, state: 'archived' });
    const [row] = await db
      .update(conversations)
      .set({ state: 'archived' })
      .where(eq(conversations.id, conv.id))
      .returning();
    void sendCsatPrompt(db, row).catch(() => {});
    bus.publish(agent.workspaceId, {
      type: 'conversation',
      data: { id: row.id, state: row.state },
    });
    return c.json({ conversation_id: externalId, state: row.state });
  });

  // Outbound — open or continue a thread on one of the agent's own channels.
  app.post(
    '/send',
    zValidator(
      'json',
      z.object({
        // Zapier sends "" for blank optional fields — normalize to undefined
        channel_id: z.preprocess(
          (v) => (v === '' ? undefined : v),
          z.string().uuid().optional(),
        ),
        to: z.string().min(1),
        text: z.string().default(''),
        subject: z.string().optional(),
        whatsapp_template: z
          .object({
            name: z.string().min(1),
            language: z.string().optional(),
            body_params: z.array(z.string()).optional(),
          })
          .optional(),
      }),
    ),
    async (c) => {
      const agent = c.get('agent');
      const body = c.req.valid('json');
      const own = await db.select().from(channels).where(eq(channels.agentId, agent.id));
      const channel = body.channel_id
        ? own.find((ch) => ch.id === body.channel_id)
        : own.find((ch) => ['sms', 'email', 'gmail', 'outlook', 'whatsapp'].includes(ch.kind));
      if (!channel)
        return c.json(
          { error: body.channel_id ? 'channel not found' : 'no outbound-capable channel' },
          400,
        );
      const r = await sendOutbound(db, channel, undefined, {
        to: body.to,
        text: body.text,
        subject: body.subject || undefined,
        template: body.whatsapp_template
          ? {
              name: body.whatsapp_template.name,
              language: body.whatsapp_template.language,
              bodyParams: body.whatsapp_template.body_params,
            }
          : undefined,
      });
      if ('error' in r && !r.conversationId) return c.json({ error: r.error }, 400);
      // external_id too — reply/escalate/resolve routes key on it, so a
      // Zap can chain Send Outbound → Send Reply without a lookup step.
      const [conv] = r.conversationId
        ? await db
            .select({ externalId: conversations.externalId })
            .from(conversations)
            .where(eq(conversations.id, r.conversationId))
            .limit(1)
        : [undefined];
      return c.json(
        {
          conversation_id: r.conversationId,
          external_id: conv?.externalId,
          mid: r.mid,
          error: r.error,
        },
        r.error ? 502 : 200,
      );
    },
  );

  // Verify an agent's webhook endpoint is reachable
  app.post('/agents/me/webhook-test', async (c) => {
    const agent = c.get('agent');
    if (!agent.webhookUrl) return c.json({ error: 'no webhook_url configured' }, 400);
    await deliverWebhook(db, agent, 'message.human', {
      conversation_id: 'webhook-test',
      janis_conversation_id: 'webhook-test',
      text: 'Janis webhook test — if you received this, your endpoint works.',
    });
    return c.json({ ok: true });
  });

  return app;
}
