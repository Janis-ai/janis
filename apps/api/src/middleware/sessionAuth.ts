import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { sha256 } from '../lib/crypto.js';

type UserRow = typeof users.$inferSelect;

export const SESSION_COOKIE = 'janis_session';

export interface SessionEnv {
  Variables: { user: UserRow; workspaceId: string };
}

/** Cookie-session auth for console /api routes. */
export function sessionAuth(db: Db) {
  return createMiddleware<SessionEnv>(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ error: 'unauthenticated' }, 401);

    const [row] = await db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row) return c.json({ error: 'unauthenticated' }, 401);

    c.set('user', row.user);
    c.set('workspaceId', row.user.workspaceId);
    await next();
  });
}
