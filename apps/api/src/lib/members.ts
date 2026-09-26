import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMembers, memberships, users } from '../db/schema.js';

/** Accepted members of a workspace (user rows, pending invites excluded). */
export function workspaceMembers(db: Db, workspaceId: string) {
  return db
    .select({ user: users })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.workspaceId, workspaceId), isNotNull(memberships.acceptedAt)));
}

/** Everyone eligible to work one agent: accepted workspace members ∪
 *  accepted agent_members (agent-scoped users carry no workspace
 *  membership, so they'd otherwise never be assignable). */
export async function agentEligibleMembers(db: Db, workspaceId: string, agentId: string) {
  const members = await workspaceMembers(db, workspaceId);
  const ids = new Set(members.map((m) => m.user.id));
  const scoped = await db
    .select({ user: users })
    .from(agentMembers)
    .innerJoin(users, eq(agentMembers.userId, users.id))
    .where(and(eq(agentMembers.agentId, agentId), isNotNull(agentMembers.acceptedAt)));
  return [...members, ...scoped.filter((s) => !ids.has(s.user.id))];
}

/** The user's membership in a workspace, if any (pending invites included). */
export async function membershipFor(db: Db, userId: string, workspaceId: string) {
  const [row] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)))
    .limit(1);
  return row;
}
