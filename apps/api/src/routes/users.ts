import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { sessionAuth, type SessionEnv } from '../middleware/sessionAuth.js';
import { hashPassword } from '../lib/crypto.js';
import { toWorkspaceUser } from '../lib/serializers.js';

const createUser = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  password: z.string().min(8),
  role: z.enum(['admin', 'member']).default('member'),
});

export function userRoutes(db: Db) {
  const app = new Hono<SessionEnv>();
  app.use('/*', sessionAuth(db));

  app.get('/', async (c) => {
    const rows = await db.select().from(users).where(eq(users.workspaceId, c.get('workspaceId')));
    return c.json({ users: rows.map(toWorkspaceUser) });
  });

  // admin-only: add a teammate to the workspace
  app.post('/', zValidator('json', createUser), async (c) => {
    if (c.get('user').role !== 'admin') return c.json({ error: 'admin required' }, 403);
    const body = c.req.valid('json');
    const [existing] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (existing) return c.json({ error: 'email already registered' }, 409);

    const [row] = await db
      .insert(users)
      .values({
        workspaceId: c.get('workspaceId'),
        email: body.email,
        name: body.name,
        role: body.role,
        passwordHash: await hashPassword(body.password),
      })
      .returning();
    return c.json({ user: toWorkspaceUser(row) }, 201);
  });

  // update your own preferences (notification channels)
  app.patch(
    '/me',
    zValidator(
      'json',
      z.object({
        notify: z
          .object({ push: z.boolean().optional(), email: z.boolean().optional() })
          .optional(),
      }),
    ),
    async (c) => {
      const me = c.get('user');
      const body = c.req.valid('json');
      const current = (me.notifyPrefs ?? {}) as { push?: boolean; email?: boolean };
      const next = {
        push: body.notify?.push ?? current.push ?? true,
        email: body.notify?.email ?? current.email ?? true,
      };
      const [row] = await db
        .update(users)
        .set({ notifyPrefs: next })
        .where(eq(users.id, me.id))
        .returning();
      return c.json({ user: toWorkspaceUser(row) });
    },
  );

  // admin-only: change a teammate's role
  app.patch(
    '/:id',
    zValidator('json', z.object({ role: z.enum(['admin', 'member']) })),
    async (c) => {
      const me = c.get('user');
      if (me.role !== 'admin') return c.json({ error: 'admin required' }, 403);
      const [row] = await db
        .update(users)
        .set({ role: c.req.valid('json').role })
        .where(and(eq(users.id, c.req.param('id')), eq(users.workspaceId, me.workspaceId)))
        .returning();
      if (!row) return c.json({ error: 'not found' }, 404);
      return c.json({ user: toWorkspaceUser(row) });
    },
  );

  // admin-only: remove a teammate (can't remove yourself)
  app.delete('/:id', async (c) => {
    const me = c.get('user');
    if (me.role !== 'admin') return c.json({ error: 'admin required' }, 403);
    if (me.id === c.req.param('id')) return c.json({ error: 'cannot remove yourself' }, 409);
    const [row] = await db
      .delete(users)
      .where(and(eq(users.id, c.req.param('id')), eq(users.workspaceId, me.workspaceId)))
      .returning();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
