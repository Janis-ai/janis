import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { savedViews } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';

const viewBody = z.object({
  name: z.string().trim().min(1).max(60),
  filters: z
    .object({
      state: z.string().max(40).optional(),
      agent_id: z.string().uuid().optional(),
      assignee: z.literal('me').optional(),
      attention: z.boolean().optional(),
      tab: z.enum(['all', 'attention']).optional(),
      query: z.string().max(200).optional(),
    })
    .strict(),
});

function toView(row: typeof savedViews.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    filters: row.filters,
    created_at: row.createdAt.toISOString(),
  };
}

/** Saved views — per-operator named filter presets for the conversations
 * list. Deliberately per-user (not shared): shared queue definitions live
 * in routing rules, views stay personal and cheap to create/delete. */
export function viewRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', async (c) => {
    const rows = await db
      .select()
      .from(savedViews)
      .where(
        and(
          eq(savedViews.workspaceId, c.get('workspaceId')),
          eq(savedViews.userId, c.get('user').id),
        ),
      )
      .orderBy(asc(savedViews.createdAt));
    return c.json({ views: rows.map(toView) });
  });

  app.post('/', zValidator('json', viewBody), async (c) => {
    const body = c.req.valid('json');
    const [row] = await db
      .insert(savedViews)
      .values({
        workspaceId: c.get('workspaceId'),
        userId: c.get('user').id,
        name: body.name,
        filters: body.filters,
      })
      .returning();
    return c.json({ view: toView(row) }, 201);
  });

  app.delete('/:id', async (c) => {
    const deleted = await db
      .delete(savedViews)
      .where(
        and(
          eq(savedViews.id, c.req.param('id')),
          eq(savedViews.workspaceId, c.get('workspaceId')),
          eq(savedViews.userId, c.get('user').id),
        ),
      )
      .returning({ id: savedViews.id });
    if (!deleted.length) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
