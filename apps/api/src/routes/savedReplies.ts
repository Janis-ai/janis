import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { savedReplies } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { toSavedReply } from '../lib/serializers.js';

const body = z.object({
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(4000),
});

export function savedReplyRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', async (c) => {
    const rows = await db
      .select()
      .from(savedReplies)
      .where(eq(savedReplies.workspaceId, c.get('workspaceId')))
      .orderBy(asc(savedReplies.title));
    return c.json({ saved_replies: rows.map(toSavedReply) });
  });

  app.post('/', zValidator('json', body), async (c) => {
    const b = c.req.valid('json');
    const [row] = await db
      .insert(savedReplies)
      .values({ workspaceId: c.get('workspaceId'), title: b.title, body: b.body })
      .returning();
    return c.json({ saved_reply: toSavedReply(row) }, 201);
  });

  app.delete('/:id', async (c) => {
    const [row] = await db
      .delete(savedReplies)
      .where(
        and(
          eq(savedReplies.id, c.req.param('id')),
          eq(savedReplies.workspaceId, c.get('workspaceId')),
        ),
      )
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
