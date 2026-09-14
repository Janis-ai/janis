import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
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

  return app;
}
