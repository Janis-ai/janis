import { and, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMembers, agents, conversations, users } from '../db/schema.js';

export type AgentRole = 'admin' | 'member';
/** null = full workspace member; a map = agent-scoped user (only these
 *  agents, with the per-agent role the row grants). */
export type AgentScope = Record<string, AgentRole> | null;

/** WHERE fragment limiting a query (joined to `agents`) to a scoped user's
 *  agents. Undefined for full workspace members — no extra condition. */
export function agentScopeCond(scope: AgentScope): SQL | undefined {
  if (!scope) return undefined;
  const ids = Object.keys(scope);
  return ids.length ? inArray(agents.id, ids) : sql`false`;
}

/** Spreadable WHERE parts for a query joined on `agents`: the workspace
 *  match plus the scope restriction when the caller is agent-scoped. */
export function agentVis(workspaceId: string, scope: AgentScope): SQL[] {
  const s = agentScopeCond(scope);
  return s ? [eq(agents.workspaceId, workspaceId), s] : [eq(agents.workspaceId, workspaceId)];
}

/** The user's effective role on one agent, or null when they can't see it.
 *  An agent_members row's role wins over the workspace role in both
 *  directions (member → agent admin, admin → agent member). Agent-scoped
 *  users have no workspace role to inherit — the scope map is the grant. */
export async function agentRoleFor(
  db: Db,
  userId: string,
  workspaceRole: AgentRole,
  scope: AgentScope,
  agentId: string,
  workspaceId: string,
): Promise<AgentRole | null> {
  if (scope) return scope[agentId] ?? null;
  const [row] = await db
    .select({ id: agents.id, role: agentMembers.role })
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
