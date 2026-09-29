/**
 * Who's looking at a conversation right now — rows in `viewers`, ~20s TTL
 * refreshed by client heartbeats. Collision detection: co-viewers see each
 * other before both reply to the same thread. DB-backed so presence survives
 * multi-instance; stale rows are ignored on read and pruned on write.
 */
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { viewers as viewersTable } from '../db/schema.js';

const TTL_MS = 20_000;

export interface Viewer {
  id: string;
  name: string | null;
}

/** Record a viewing heartbeat. Returns the live viewer set (all users, the
 * caller included) and whether it changed since before this heartbeat —
 * callers broadcast a presence event only on change. */
export async function markViewing(
  db: Db,
  convId: string,
  userId: string,
  name: string | null,
): Promise<{ viewers: Viewer[]; changed: boolean }> {
  const now = new Date();
  const before = await db
    .select({ userId: viewersTable.userId })
    .from(viewersTable)
    .where(and(eq(viewersTable.conversationId, convId), gt(viewersTable.expiresAt, now)));
  const beforeIds = new Set(before.map((r) => r.userId));

  await db
    .insert(viewersTable)
    .values({ conversationId: convId, userId, userName: name ?? '', expiresAt: new Date(now.getTime() + TTL_MS) })
    .onConflictDoUpdate({
      target: [viewersTable.conversationId, viewersTable.userId],
      set: { userName: name ?? '', expiresAt: new Date(now.getTime() + TTL_MS) },
    });
  await db.delete(viewersTable).where(lt(viewersTable.expiresAt, now));

  const rows = await db
    .select({ userId: viewersTable.userId, userName: viewersTable.userName })
    .from(viewersTable)
    .where(and(eq(viewersTable.conversationId, convId), gt(viewersTable.expiresAt, now)));
  const afterIds = new Set(rows.map((r) => r.userId));
  const changed = beforeIds.size !== afterIds.size || [...afterIds].some((id) => !beforeIds.has(id));
  return { viewers: rows.map((r) => ({ id: r.userId, name: r.userName || null })), changed };
}
