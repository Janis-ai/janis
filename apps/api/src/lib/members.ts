import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memberships, users } from '../db/schema.js';

/** Accepted members of a workspace (user rows, pending invites excluded). */
export function workspaceMembers(db: Db, workspaceId: string) {
  return db
    .select({ user: users })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.workspaceId, workspaceId), isNotNull(memberships.acceptedAt)));
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
