import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { savedReplies } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { agentRoleFor } from '../lib/access.js';
import { toSavedReply } from '../lib/serializers.js';

const body = z.object({
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(4000),
  // scope the reply to one agent — merges with workspace replies in that
  // agent's conversations
  agent_id: z.string().uuid().nullable().optional(),
});

export function savedReplyRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  // ?agent_id=<id> returns workspace replies + that agent's own (merged);
  // bare returns workspace-wide only.
  app.get('/', async (c) => {
    const agentId = c.req.query('agent_id');
    const where = agentId
      ? and(
          eq(savedReplies.workspaceId, c.get('workspaceId')),
          or(isNull(savedReplies.agentId), eq(savedReplies.agentId, agentId)),
        )
      : and(eq(savedReplies.workspaceId, c.get('workspaceId')), isNull(savedReplies.agentId));
    const rows = await db
      .select()
      .from(savedReplies)
      .where(where)
      .orderBy(asc(savedReplies.agentId), asc(savedReplies.title)); // agent's own first
    return c.json({ saved_replies: rows.map(toSavedReply) });
  });

  app.post('/', zValidator('json', body), async (c) => {
    const b = c.req.valid('json');
    // Workspace-level replies are workspace-member territory — scoped users
    // can only add replies to agents they're on.
    if (!b.agent_id && c.get('agentScope')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (b.agent_id) {
      const role = await agentRoleFor(
        db, c.get('user').id, c.get('role'), c.get('agentScope'), b.agent_id, c.get('workspaceId'),
      );
      if (!role) return c.json({ error: 'agent not found' }, 404);
    }
    const [row] = await db
      .insert(savedReplies)
      .values({
        workspaceId: c.get('workspaceId'),
        agentId: b.agent_id ?? null,
        title: b.title,
        body: b.body,
      })
      .returning();
    return c.json({ saved_reply: toSavedReply(row) }, 201);
  });

  app.delete('/:id', async (c) => {
    const [row] = await db
      .select()
      .from(savedReplies)
      .where(
        and(
          eq(savedReplies.id, c.req.param('id')),
          eq(savedReplies.workspaceId, c.get('workspaceId')),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    if (!row.agentId && c.get('agentScope')) return c.json({ error: 'forbidden' }, 403);
    if (row.agentId) {
      const role = await agentRoleFor(
        db, c.get('user').id, c.get('role'), c.get('agentScope'), row.agentId, c.get('workspaceId'),
      );
      if (!role) return c.json({ error: 'not found' }, 404);
    }
    await db.delete(savedReplies).where(eq(savedReplies.id, row.id));
    return c.json({ ok: true });
  });

  return app;
}
