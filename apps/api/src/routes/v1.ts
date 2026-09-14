import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { IngestRequest } from '@janis/shared';
import type { Db } from '../db/client.js';
import { conversations } from '../db/schema.js';
import { agentAuth, type AgentAuthEnv } from '../middleware/agentAuth.js';
import { deliverWebhook } from '../lib/webhooks.js';
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
    zValidator('json', z.object({ conversation_id: z.string(), text: z.string().min(1) })),
    async (c) => {
      const agent = c.get('agent');
      const { conversation_id, text } = c.req.valid('json');
      const [conv] = await db
        .select()
        .from(conversations)
        .where(
          and(eq(conversations.agentId, agent.id), eq(conversations.externalId, conversation_id)),
        )
        .limit(1);
      if (!conv) return c.json({ error: 'conversation not found' }, 404);
      const row = await storeSuggestion(db, conv.id, text, 'agent');
      return c.json({ suggestion: { id: row.id } }, 201);
    },
  );

  // Agent's behavior config — polled by template-based agents at runtime
  app.get('/config', (c) => {
    const agent = c.get('agent');
    return c.json({ config: agent.config ?? {} });
  });

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
