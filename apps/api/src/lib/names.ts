import { eq, ne, and } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, memberGroups } from '../db/schema.js';

const norm = (s: string) => s.trim().toLowerCase();

/** Agents and groups share ONE namespace per workspace — "Support" in a rule
 *  target or mention is ambiguous if it names both. Uniqueness is enforced in
 *  both directions at write time, case-insensitive. excludeId lets a rename
 *  keep its own name without colliding with itself. */
export async function agentNameTaken(
  db: Db,
  workspaceId: string,
  name: string,
  excludeId?: string,
) {
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(
      excludeId
        ? and(eq(agents.workspaceId, workspaceId), ne(agents.id, excludeId))
        : eq(agents.workspaceId, workspaceId),
    );
  const n = norm(name);
  return rows.some((r) => norm(r.name) === n);
}

export async function groupNameTaken(
  db: Db,
  workspaceId: string,
  name: string,
  excludeId?: string,
) {
  const rows = await db
    .select({ id: memberGroups.id, name: memberGroups.name })
    .from(memberGroups)
    .where(
      excludeId
        ? and(eq(memberGroups.workspaceId, workspaceId), ne(memberGroups.id, excludeId))
        : eq(memberGroups.workspaceId, workspaceId),
    );
  const n = norm(name);
  return rows.some((r) => norm(r.name) === n);
}
