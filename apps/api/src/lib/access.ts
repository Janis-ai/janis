import { and, eq, inArray, isNotNull, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMembers, agents, conversations, users } from '../db/schema.js';

/** Effective role on an agent. 'owner' outranks admin and always wins —
 * set via agents.owner_user_id, never stored on agent_members rows. The
 * storage-only 'hidden' row role resolves to null (no access). */
export type AgentRole = 'owner' | 'admin' | 'member';

export const isAdminRole = (r: AgentRole | null | undefined): boolean =>
  r === 'admin' || r === 'owner';

/** Everything the session needs to decide agent visibility:
 *  - grants non-null: agent-scoped user — only these agents exist for them.
 *  - grants null: full workspace member; `hidden` lists agents they were
 *    explicitly denied via agent_members.role='hidden'. */
export interface AgentScope {
  grants: Record<string, AgentRole> | null;
  hidden: string[];
}

export const FULL_SCOPE: AgentScope = { grants: null, hidden: [] };

/** WHERE fragment limiting a query (joined to `agents`) to what the user
 *  can see: the grant map for scoped users, minus hidden agents for
 *  workspace members. Undefined when nothing restricts visibility. */
export function agentScopeCond(scope: AgentScope | null | undefined): SQL | undefined {
  const parts: SQL[] = [];
  if (scope?.grants) {
    const ids = Object.keys(scope.grants);
    parts.push(ids.length ? inArray(agents.id, ids) : sql`false`);
  }
  if (scope?.hidden.length) parts.push(notInArray(agents.id, scope.hidden));
  return parts.length ? and(...parts) : undefined;
}

/** Spreadable WHERE parts for a query joined on `agents`: the workspace
 *  match plus the user's visibility restriction. */
export function agentVis(workspaceId: string, scope: AgentScope | null): SQL[] {
  const s = agentScopeCond(scope);
  return s ? [eq(agents.workspaceId, workspaceId), s] : [eq(agents.workspaceId, workspaceId)];
}

/** The user's effective role on one agent, or null when they can't see it.
 *  Owner always wins (it's on the agents row, not agent_members). Then: a
 *  scoped user sees only their granted agents; a 'hidden' row denies access;
 *  otherwise an agent_members role overrides the workspace role either way.
 *  Agent-scoped users have no workspace role to inherit — the grant map is
 *  the grant. */
export async function agentRoleFor(
  db: Db,
  userId: string,
  workspaceRole: AgentRole,
  scope: AgentScope,
  agentId: string,
  workspaceId: string,
): Promise<AgentRole | null> {
  const [row] = await db
    .select({ id: agents.id, role: agentMembers.role, ownerId: agents.ownerUserId })
    .from(agents)
    .leftJoin(
      agentMembers,
      and(
        eq(agentMembers.agentId, agents.id),
        eq(agentMembers.userId, userId),
        isNotNull(agentMembers.acceptedAt),
      ),
    )
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null; // agent isn't in this workspace
  if (row.ownerId === userId) return 'owner';
  if (scope?.grants) return scope.grants[agentId] ?? null;
  if (row.role === 'hidden') return null;
  return row.role ?? workspaceRole;
}

/** Resolve a conversation → agent the scoped user can act on, or null.
 *  Shared by every per-conversation route's ownership check. */
export async function conversationAgent(
  db: Db,
  workspaceId: string,
  scope: AgentScope,
  conversationId: string,
) {
  const cond = agentScopeCond(scope);
  const [row] = await db
    .select({ conversation: conversations, agent: agents })
    .from(conversations)
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(agents.workspaceId, workspaceId),
        ...(cond ? [cond] : []),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The operator identity shown to customers on this agent's channels. A
 * per-agent override (agent_members) wins over the user's global profile;
 * an effective show_identity false withholds name/avatar entirely.
 * `name` is null when the operator stays anonymous.
 */
export async function operatorIdentity(
  db: Db,
  user: typeof users.$inferSelect,
  agentId: string,
): Promise<{ name: string | null; avatar: string | null }> {
  const [ov] = await db
    .select({
      displayName: agentMembers.displayName,
      avatarUrl: agentMembers.avatarUrl,
      showIdentity: agentMembers.showIdentity,
    })
    .from(agentMembers)
    .where(and(eq(agentMembers.agentId, agentId), eq(agentMembers.userId, user.id)))
    .limit(1);
  const show = ov?.showIdentity ?? user.showIdentity;
  if (show === false) return { name: null, avatar: null };
  return {
    name: ov?.displayName || user.displayName || user.name.split(' ')[0] || user.name,
    avatar: ov?.avatarUrl ?? user.avatarUrl,
  };
}
