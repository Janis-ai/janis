import { sql } from 'drizzle-orm';
import type { Db, ReservedSql } from '../db/client.js';
import { lockClient } from '../db/client.js';
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
// With real session semantics (direct endpoint) a run's hold is a handful of
// seconds; >20s means the holder is wedged and the wait only delays the
// customer's reply — the unlocked path below replies anyway.
const WAIT_BUDGET_MS = 20_000;
const POLL_MS = 250;

export async function acquireConvLock(
  db: Db,
  convId: string,
): Promise<(() => Promise<void>) | null> {
  if (!env.databaseUrl) return null; // PGlite — single instance, Map suffices
  // Dedicated direct-endpoint client — through the -pooler host a "session"
  // advisory lock attaches to a pooled backend the unlock statement may never
  // see, leaking the lock until that backend dies. (Neon transaction pooling
  // re-binds backends per statement; reserve() pins the client↔pooler TCP
  // conn, not the backend.) On a direct conn, reserve() pins the backend and
  // a crash really does drop the lock.
  const client = lockClient();
  if (!client) return null;
  const started = Date.now();
  const deadline = started + WAIT_BUDGET_MS;
  // reserve() waits indefinitely when the pool's conns are checked out — a
  // conn held by a run wedged on a dead socket never releases, and postgres-js
  // v3 has no query timeout, so both the reserve and the lock queries get
  // explicit deadlines. A wedged reserve would otherwise park the run inside
  // acquireConvLock forever: convRuns stays 'running' and every later inbound
  // on this instance sets pending on a run nobody services.
  let conn: ReservedSql;
  const reserveP = client.reserve();
  try {
    conn = await Promise.race([
      reserveP,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('reserve timeout')), WAIT_BUDGET_MS / 2),
      ),
    ]);
  } catch (err) {
    // A late reserve still resolves eventually — release its conn back to the
    // pool or it leaks alongside the wedged one.
    void reserveP.then((c) => c.release()).catch(() => {});
    // Direct endpoint unreachable (Neon conn ceiling, transient network) —
    // fail open like the wait timeout: an unlocked reply beats none.
    console.warn(`[convLock] ${convId}: lock conn failed — replying unlocked`, err);
    return null;
  }
  try {
    while (true) {
      // A dead-but-unclosed socket hangs this query forever (postgres-js v3
      // has no query timeout) — race it so the run can't wedge holding a
      // reserved conn it never releases.
      const [{ ok }] = await Promise.race([
        conn`select pg_try_advisory_lock(${LOCK_NS}, hashtext(${convId})) as ok`,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('lock query timeout')), 10_000),
        ),
      ]);
      if (ok) {
        const waited = Date.now() - started;
        if (waited > 5_000)
          console.warn(`[convLock] ${convId}: acquired after ${waited}ms wait`);
        return async () => {
          try {
            // Dead conn → this query hangs without a timeout, and conn.release
            // in the finally would never run — a leaked conn that shrinks the
            // lock pool by one for every wedged unlock. Race it so release is
            // guaranteed; if the backend is dead its session lock is gone
            // anyway.
            await Promise.race([
              conn`select pg_advisory_unlock(${LOCK_NS}, hashtext(${convId}))`,
              new Promise<never>((_, rej) =>
                setTimeout(() => rej(new Error('unlock query timeout')), 10_000),
              ),
            ]);
          } catch (err) {
            console.warn(`[convLock] ${convId}: unlock failed — releasing conn anyway`, err);
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
    console.warn(`[convLock] ${convId}: lock query failed — replying unlocked`, err);
    return null;
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
      // Internal audit lines (payload.internal — rule fires, state changes,
      // operator whispers) are 'out'-direction bookkeeping, not answers:
      // counting them makes a fresh inbound look replied-to and the run
      // silently skips. Flagged agent notes (failure/handoff) carry no
      // internal marker — they're real turns and do count.
      lastReply: sql<Date | null>`max(case when ${messages.direction} <> 'in' and coalesce(${messages.payload}->>'internal', 'false') <> 'true' then ${messages.createdAt} end)`,
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
