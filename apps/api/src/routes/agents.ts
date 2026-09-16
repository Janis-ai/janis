import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AgentConfig } from '@janis/shared';
import type { Db } from '../db/client.js';
import { agents, conversations, knowledgeFiles, webhookDeliveries } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { generateApiKey, generateWebhookSecret } from '../lib/crypto.js';
import { deliverWebhook } from '../lib/webhooks.js';
import { extractKnowledgeText, UnsupportedFileError } from '../lib/knowledge.js';
import { llmFor } from '../lib/hostedAgent.js';
import { processEvents } from '../services/ingest.js';
import { toAgent } from '../lib/serializers.js';

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
  config: AgentConfig.optional(),
});

export function agentRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', async (c) => {
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, c.get('workspaceId')))
      .orderBy(desc(agents.createdAt));
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
        hosted: body.hosted ?? false,
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
        ...(body.hosted !== undefined ? { hosted: body.hosted } : {}),
        ...(body.auto_resume_minutes !== undefined
          ? { autoResumeMinutes: body.auto_resume_minutes }
          : {}),
        ...(body.config !== undefined ? { config: body.config } : {}),
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

  // Reveal the webhook secret (needed to verify signatures agent-side)
  app.get('/:id/webhook-secret', async (c) => {
    const [row] = await db
      .select({ webhookSecret: agents.webhookSecret })
      .from(agents)
      .where(and(eq(agents.id, c.req.param('id')), eq(agents.workspaceId, c.get('workspaceId'))))
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ webhook_secret: row.webhookSecret });
  });

  // Recent outbound webhook deliveries — for debugging agent wiring
  app.get('/:id/deliveries', async (c) => {
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
      .limit(20);
    return c.json({
      deliveries: rows.map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        attempts: r.attempts,
        last_error: r.lastError,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  // Test chat — try the agent without wiring a channel. One test conversation
  // per operator per agent.
  app.post(
    '/:id/chat',
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
      if (conv?.state === 'active') {
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
  app.get('/:id/knowledge', async (c) => {
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
        created_at: r.createdAt.toISOString(),
      })),
    });
  });

  app.post('/:id/knowledge', async (c) => {
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
    if (count >= 50) return c.json({ error: 'knowledge file limit reached (50)' }, 409);

    const buf = Buffer.from(await file.arrayBuffer());
    let text: string;
    try {
      text = await extractKnowledgeText(buf, file.type, file.name, llmFor(agent));
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

  app.delete('/:id/knowledge/:fileId', async (c) => {
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
