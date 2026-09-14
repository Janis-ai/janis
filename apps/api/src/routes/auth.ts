import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, users, workspaces } from '../db/schema.js';
import { generateSessionToken, sha256, verifyPassword } from '../lib/crypto.js';
import { SESSION_COOKIE } from '../middleware/sessionAuth.js';
import { toWorkspaceUser } from '../lib/serializers.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const credentials = z.object({ email: z.string().email(), password: z.string().min(1) });

export function authRoutes(db: Db) {
  const app = new Hono();

  app.post('/login', zValidator('json', credentials), async (c) => {
    const { email, password } = c.req.valid('json');
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return c.json({ error: 'invalid credentials' }, 401);
    }

    const { token, id } = generateSessionToken();
    await db.insert(sessions).values({
      id,
      userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.json({ user: toWorkspaceUser(user) });
  });

  app.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await db.delete(sessions).where(eq(sessions.id, sha256(token)));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/me', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ error: 'unauthenticated' }, 401);
    const [row] = await db
      .select({ user: users, workspace: workspaces })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .innerJoin(workspaces, eq(users.workspaceId, workspaces.id))
      .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row) return c.json({ error: 'unauthenticated' }, 401);
    return c.json({
      user: toWorkspaceUser(row.user),
      workspace: { id: row.workspace.id, name: row.workspace.name },
    });
  });

  return app;
}
