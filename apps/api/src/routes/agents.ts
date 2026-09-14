import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { generateApiKey, generateWebhookSecret, sha256 } from '../lib/crypto.js';
import { deliverWebhook } from '../lib/webhooks.js';
import { toAgent } from '../lib/serializers.js';

const createAgent = z.object({
  name: z.string().min(1).max(120),
  webhook_url: z.string().url().optional(),
  auto_resume_minutes: z.number().min(1).max(10080).optional(),
});
const updateAgent = z.object({
  name: z.string().min(1).max(120).optional(),
  webhook_url: z.string().url().nullable().optional(),
  auto_resume_minutes: z.number().min(1).max(10080).nullable().optional(),
});

export function agentRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', async (c) => {
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, c.get('workspaceId')));
    return c.json({ agents: rows.map(toAgent) });
  });

  app.post('/', zValidator('json', createAgent), async (c) => {
    const body = c.req.valid('json');
    const { key, hash, preview } = generateApiKey();
    const [row] = await db
      .insert(agents)
      .values({
        workspaceId: c.get('workspaceId'),
        name: body.name,
        apiKeyHash: hash,
        apiKeyPreview: preview,
        webhookSecret: generateWebhookSecret(),
        webhookUrl: body.webhook_url ?? null,
        autoResumeMinutes: body.auto_resume_minutes ?? null,
      })
      .returning();
    // Full key is returned exactly once — store a hash only
    return c.json({ agent: toAgent(row), api_key: key }, 201);
  });

  app.patch('/:id', zValidator('json', updateAgent), async (c) => {
    const body = c.req.valid('json');
    const [row] = await db
      .update(agents)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.webhook_url !== undefined ? { webhookUrl: body.webhook_url } : {}),
        ...(body.auto_resume_minutes !== undefined
          ? { autoResumeMinutes: body.auto_resume_minutes }
          : {}),
      })
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ agent: toAgent(row) });
  });

  app.post('/:id/rotate-key', async (c) => {
    const { key, hash, preview } = generateApiKey();
    const [row] = await db
      .update(agents)
      .set({ apiKeyHash: hash, apiKeyPreview: preview })
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ agent: toAgent(row), api_key: key });
  });

  app.post('/:id/rotate-webhook-secret', async (c) => {
    const secret = generateWebhookSecret();
    const [row] = await db
      .update(agents)
      .set({ webhookSecret: secret })
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ agent: toAgent(row), webhook_secret: secret });
  });

  app.post('/:id/webhook-test', async (c) => {
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    if (!row.webhookUrl) return c.json({ error: 'no webhook_url configured' }, 400);
    await deliverWebhook(db, row, 'message.human', {
      conversation_id: 'webhook-test',
      janis_conversation_id: 'webhook-test',
      text: 'Janis webhook test — if you received this, your endpoint works.',
    });
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    const [row] = await db
      .delete(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
