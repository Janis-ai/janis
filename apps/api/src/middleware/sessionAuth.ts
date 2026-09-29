import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMembers, agents, memberships, sessions, users } from '../db/schema.js';
import { sha256 } from '../lib/crypto.js';
import { agentRoleFor, isAdminRole, type AgentRole, type AgentScope } from '../lib/access.js';

type UserRow = typeof users.$inferSelect;

export const SESSION_COOKIE = 'janis_session';

/** Writes a viewer role can still make — own account prefs, push
 *  subscription, personal saved views. Everything else is GET-only. */
const VIEWER_WRITE_ALLOWLIST = [
  /^\/api\/users\/me$/,
  /^\/api\/push(\/|$)/,
  /^\/api\/views(\/|$)/,
];

export interface SessionEnv {
  Variables: {
    user: UserRow;
    workspaceId: string;
    role: AgentRole;
    /** {grants: null} = full workspace member (hidden lists their denied
     *  agents). grants set = agent-scoped: these agents are all they see. */
    agentScope: AgentScope;
  };
}

/** Cookie-session auth for console /api routes. The session's workspace_id
 * is the active workspace; role comes from the user's membership there.
 * Users without a membership but with agent_members rows land scoped to
 * just those agents (role 'member' at the workspace level — they can never
 * pass adminOnly). */
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
    // Agent-scoped session: the pinned workspace is reachable via grants
    // even without a membership — resolve scoped context instead of stealing
    // the session back to an unrelated membership.
    if (!membership && row.session.workspaceId) {
      const granted = await db
        .select({ agentId: agentMembers.agentId, role: agentMembers.role })
        .from(agentMembers)
        .innerJoin(agents, eq(agentMembers.agentId, agents.id))
        .where(
          and(
            eq(agentMembers.userId, row.user.id),
            eq(agents.workspaceId, row.session.workspaceId),
            isNotNull(agentMembers.acceptedAt),
          ),
        )
        .limit(50);
      // 'hidden' rows deny access — they can never be a grant.
      const grants = granted.filter((g) => g.role !== 'hidden');
      if (grants.length) {
        c.set('user', row.user);
        c.set('workspaceId', row.session.workspaceId);
        c.set('role', 'member');
        c.set('agentScope', {
          grants: Object.fromEntries(
            grants.map((g) => [g.agentId, (g.role ?? 'member') as AgentRole]),
          ),
          hidden: [],
        });
        await next();
        return;
      }
    }

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

    if (!membership) {
      // Agent-scoped user: no workspace membership, but agent_members rows
      // grant access to individual agents. The session's workspace is the
      // owning workspace of the matching agent (or the first granted one).
      const granted = await db
        .select({ agentId: agentMembers.agentId, role: agentMembers.role, ws: agents.workspaceId })
        .from(agentMembers)
        .innerJoin(agents, eq(agentMembers.agentId, agents.id))
        .where(and(eq(agentMembers.userId, row.user.id), isNotNull(agentMembers.acceptedAt)))
        .limit(50);
      const usable = granted.filter((g) => g.role !== 'hidden');
      if (!usable.length) return c.json({ error: 'no_workspace' }, 401);
      const wsId = usable.find((g) => g.ws === row.session.workspaceId)?.ws ?? usable[0].ws;
      if (wsId !== row.session.workspaceId) {
        await db
          .update(sessions)
          .set({ workspaceId: wsId })
          .where(eq(sessions.id, sessionId));
      }
      c.set('user', row.user);
      c.set('workspaceId', wsId);
      c.set('role', 'member');
      c.set('agentScope', {
        grants: Object.fromEntries(
          usable
            .filter((g) => g.ws === wsId)
            .map((g) => [g.agentId, (g.role ?? 'member') as AgentRole]),
        ),
        hidden: [],
      });
      await next();
      return;
    }

    // Workspace member — gather their 'hidden' agent rows so list/visibility
    // queries can exclude agents they were explicitly denied.
    const hiddenRows = await db
      .select({ agentId: agentMembers.agentId })
      .from(agentMembers)
      .innerJoin(agents, eq(agentMembers.agentId, agents.id))
      .where(
        and(
          eq(agentMembers.userId, row.user.id),
          eq(agents.workspaceId, membership.workspaceId),
          eq(agentMembers.role, 'hidden'),
          isNotNull(agentMembers.acceptedAt),
        ),
      );
    c.set('user', row.user);
    c.set('workspaceId', membership.workspaceId);
    c.set('role', membership.role);
    c.set('agentScope', { grants: null, hidden: hiddenRows.map((h) => h.agentId) });
    // Viewers are read-only: any session-gated write outside the self-service
    // allowlist 403s. Checking here (not per-route) means a missed route can
    // never widen the role — adminOnly/agent-scoped gates stack on top.
    if (
      membership.role === 'viewer' &&
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      !VIEWER_WRITE_ALLOWLIST.some((r) => r.test(c.req.path))
    ) {
      return c.json({ error: 'viewers are read-only' }, 403);
    }
    await next();
  });
}

/** Gate a route to workspace admins — mount after sessionAuth. Agent-scoped
 * users never pass (they hold no workspace role). */
export const adminOnly = createMiddleware<SessionEnv>(async (c, next) => {
  if (c.get('role') !== 'admin' || c.get('agentScope').grants) {
    return c.json({ error: 'admin required' }, 403);
  }
  await next();
});

/** Gate a per-agent route to that agent's admins: the workspace admin, or a
 *  user whose effective role on THIS agent is admin (a member promoted by
 *  an agent_members row — or a scoped user granted admin on the agent).
 *  The route must use `:id` for the agent id. */
export function agentAdminOnly(db: Db) {
  return createMiddleware<SessionEnv>(async (c, next) => {
    const role = await agentRoleFor(
      db,
      c.get('user').id,
      c.get('role'),
      c.get('agentScope'),
      c.req.param('id')!,
      c.get('workspaceId'),
    );
    if (!isAdminRole(role)) return c.json({ error: 'admin required' }, 403);
    await next();
  });
}

/** Gate a per-agent route to anyone who can see the agent (any role). `:id`
 *  must be the agent id. */
export function agentMemberOnly(db: Db) {
  return createMiddleware<SessionEnv>(async (c, next) => {
    const role = await agentRoleFor(
      db,
      c.get('user').id,
      c.get('role'),
      c.get('agentScope'),
      c.req.param('id')!,
      c.get('workspaceId'),
    );
    if (!role) return c.json({ error: 'not found' }, 404);
    await next();
  });
}
