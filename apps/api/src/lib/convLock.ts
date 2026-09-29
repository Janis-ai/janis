import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { env } from '../env.js';
import { messages } from '../db/schema.js';

/**
 * Cross-instance serialization for hosted-agent reply runs.
 *
 * convRuns (hostedAgent.ts) is a per-process Map — fine on one instance, but
 * under --max-instances N two inbound messages for the same conversation can
 * land on different instances and both reply → double customer-visible
 * responses. A Postgres session advisory lock closes that gap: whoever holds
 * it owns the run; contenders wait, then no-op because their inbound was
 * already answered (see newestInboundIsPending below).
 *
 * Session-scoped on purpose: if a holder crashes (SIGKILL mid-run), the lock
 * dies with the connection — no stale-lock cleanup needed.
 *
 * PGlite/dev mode is single-instance by definition, so this returns null and
 * the caller falls back to the in-process Map alone.
 */

// 'janis' as a fixed namespace so our keys never collide with advisory locks
// taken for other purposes (sweeper, migrations).
const LOCK_NS = 0x6a616e69; // 'jani'
const WAIT_BUDGET_MS = 90_000; // LLM runs can take ~30s; waiting beats a double reply
const POLL_MS = 250;

type ReservedSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  release(): void;
};

export async function acquireConvLock(
  db: Db,
  convId: string,
): Promise<(() => Promise<void>) | null> {
  if (!env.databaseUrl) return null; // PGlite — single instance, Map suffices
  // postgres-js driver exposes the raw Sql as $client; reserve() pins a
  // dedicated connection for the lock's lifetime.
  const client = (db as unknown as { $client: { reserve(): Promise<ReservedSql> } }).$client;
  const conn = await client.reserve();
  const deadline = Date.now() + WAIT_BUDGET_MS;
  try {
    while (true) {
      const [{ ok }] = await conn`select pg_try_advisory_lock(${LOCK_NS}, hashtext(${convId})) as ok`;
      if (ok) {
        return async () => {
          try {
            await conn`select pg_advisory_unlock_all()`; // belt & suspenders before pooling
          } finally {
            conn.release();
          }
        };
      }
      if (Date.now() > deadline) {
        // Never leave a customer unanswered — proceed unlocked rather than
        // silently dropping the reply. The wait only fails if a run is wedged.
        console.warn(`[convLock] ${convId}: advisory lock wait exceeded ${WAIT_BUDGET_MS}ms — replying unlocked`);
        conn.release();
        return null;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } catch (err) {
    conn.release();
    throw err;
  }
}

/** True when the customer's latest inbound is still unanswered — i.e. an
 * 'in' message newer than the newest 'out'/'human' exists. Comparing
 * directions' max timestamps (rather than "is the newest message inbound")
 * survives operator internal notes/interjections landing mid-run.
 * A contender that waited on the lock finds its inbound already answered
 * (last_reply >= last_in) and no-ops instead of double-replying. */
export async function newestInboundIsPending(db: Db, convId: string): Promise<boolean> {
  const [row] = await db
    .select({
      lastIn: sql<Date | null>`max(case when ${messages.direction} = 'in' then ${messages.createdAt} end)`,
      lastReply: sql<Date | null>`max(case when ${messages.direction} <> 'in' then ${messages.createdAt} end)`,
    })
    .from(messages)
    .where(sql`${messages.conversationId} = ${convId}`);
  if (!row?.lastIn) return false;
  // postgres-js hands raw sql`` aggregates back unparsed — coerce so the
  // comparison is numeric on both drivers.
  const lastIn = +new Date(row.lastIn);
  const lastReply = row.lastReply ? +new Date(row.lastReply) : 0;
  return lastIn > lastReply;
}
