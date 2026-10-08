import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, memberGroups } from '../db/schema.js';

const norm = (s: string) => s.trim().toLowerCase();

/** Agent and group names share a namespace per workspace — "Support" in a
 *  rule or mention is ambiguous if it's both. Both directions are enforced
 *  at write time: agents can't take a group's name and vice versa. */
export async function agentNameTaken(db: Db, workspaceId: string, name: string) {
  const rows = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));
  const n = norm(name);
  return rows.some((r) => norm(r.name) === n);
}

export async function groupNameTaken(db: Db, workspaceId: string, name: string) {
  const rows = await db
    .select({ name: memberGroups.name })
    .from(memberGroups)
    .where(eq(memberGroups.workspaceId, workspaceId));
  const n = norm(name);
  return rows.some((r) => norm(r.name) === n);
}
