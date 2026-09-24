import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memberships, sessions, users } from '../db/schema.js';
import { sha256 } from '../lib/crypto.js';

type UserRow = typeof users.$inferSelect;
type Role = 'admin' | 'member';

export const SESSION_COOKIE = 'janis_session';

export interface SessionEnv {
  Variables: { user: UserRow; workspaceId: string; role: Role };
}

/** Cookie-session auth for console /api routes. The session's workspace_id
 * is the active workspace; role comes from the user's membership there. */
export function sessionAuth(db: Db) {
  return createMiddleware<SessionEnv>(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ error: 'unauthenticated' }, 401);

    const sessionId = sha256(token);
    const [row] = await db
      .select({ user: users, session: sessions })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row) return c.json({ error: 'unauthenticated' }, 401);

    // Resolve the active workspace: the session's choice if the membership is
    // still valid, else fall back to the user's first accepted membership and
    // self-heal the session row.
    let membership = row.session.workspaceId
      ? (
          await db
            .select()
            .from(memberships)
            .where(
              and(
                eq(memberships.userId, row.user.id),
                eq(memberships.workspaceId, row.session.workspaceId),
                isNotNull(memberships.acceptedAt),
              ),
            )
            .limit(1)
        )[0]
      : undefined;
    if (!membership) {
      [membership] = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, row.user.id), isNotNull(memberships.acceptedAt)))
        .limit(1);
      if (membership) {
        await db
          .update(sessions)
          .set({ workspaceId: membership.workspaceId })
          .where(eq(sessions.id, sessionId));
        await db
          .update(users)
          .set({ lastWorkspaceId: membership.workspaceId })
          .where(eq(users.id, row.user.id));
      }
    }
    if (!membership) return c.json({ error: 'no_workspace' }, 401);

    c.set('user', row.user);
    c.set('workspaceId', membership.workspaceId);
    c.set('role', membership.role);
    await next();
  });
}

/** Gate a route to workspace admins — mount after sessionAuth. */
export const adminOnly = createMiddleware<SessionEnv>(async (c, next) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'admin required' }, 403);
  await next();
});
