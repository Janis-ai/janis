import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { env } from '../env.js';
import * as schema from './schema.js';

// src/db/client.ts → apps/api/drizzle (dev); dist/db/client.js → same (prod)
const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

// Two drivers, one schema: real Postgres via DATABASE_URL in production,
// embedded PGlite for zero-install local development. The db generic only
// affects query-result plumbing; row types come from the table definitions.
export type Db = PgDatabase<any, any>;

// Session-level advisory locks are broken through Neon's transaction-mode
// pooler: a pooled connection re-binds to a different backend per statement,
// so pg_try_advisory_lock lands on backend A while pg_advisory_unlock_all
// runs on backend B — the lock leaks until the pooled backend dies (it
// doesn't; the pooler keeps it warm and reissues it). Lock traffic goes to
// the direct endpoint where a reserved connection is a real session.
let lockSqlClient: { reserve(): Promise<ReservedSql> } | null = null;
export type ReservedSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  release(): void;
};

export function lockClient() {
  return lockSqlClient;
}

export async function createDb(): Promise<Db> {
  if (env.databaseUrl) {
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { default: postgres } = await import('postgres');
    const sql = postgres(env.databaseUrl, {
      max: env.dbPoolMax,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    const directUrl = env.databaseUrl.replace(/-pooler\./, '.');
    lockSqlClient = (
      directUrl === env.databaseUrl
        ? sql
        : postgres(directUrl, { max: 4, idle_timeout: 20, connect_timeout: 10 })
    ) as never;
    return drizzle(sql, { schema }) as unknown as Db;
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const fs = await import('node:fs/promises');
  const open = () => drizzle(new PGlite(env.pgliteDir), { schema }) as unknown as Db;
  // The owner file sits BESIDE the datadir — stray files inside PGDATA could
  // upset the engine. PGlite stubs postmaster.pid at -42, so a real pid file
  // is the only way the self-heal below can tell a live holder from a wedged
  // leftover. (A kill(0) ESRCH/EPERM check can't run on a negative pid, and
  // treating a live holder as dead renames the data dir mid-flight.)
  const ownerFile = `${env.pgliteDir}.owner`;
  const markOwner = () =>
    fs.writeFile(ownerFile, String(process.pid)).catch(() => {});
  // A positive response to kill(pid, 0) means alive; EPERM also means alive
  // (a process we don't own). ESRCH or a missing/unreadable file means dead.
  const pidAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  // Live-holder check: our sibling .owner file (or a positive postmaster.pid,
  // for dirs PGlite wrote a real pid into). PGlite does NOT lock the data
  // dir — a second process can open it and write concurrently — so the
  // owner file is also the dual-writer guard, not just wedge detection.
  const liveHolder = async (): Promise<number | null> => {
    for (const file of [ownerFile, `${env.pgliteDir}/postmaster.pid`]) {
      try {
        const pid = Number((await fs.readFile(file, 'utf8')).split('\n')[0]);
        if (pid !== process.pid && pidAlive(pid)) return pid;
      } catch {
        // unreadable file — try the next marker
      }
    }
    return null;
  };
  try {
    // Refuse to open a dir a live process owns BEFORE touching it — two
    // writers on one PGlite dir is how data actually dies.
    const owner = await liveHolder();
    if (owner) {
      throw new Error(
        `PGlite dir ${env.pgliteDir} is owned by live pid ${owner} — refusing to open a second writer (kill that process or point PGLITE_DIR elsewhere)`,
      );
    }
    const db = open();
    // PGlite init is lazy — force it now so a wedged dir (a killed tsx watch
    // leaves one: initdb/WAL aborts on every subsequent boot) fails HERE.
    await db.execute(sql`select 1`);
    await markOwner();
    return db;
  } catch (err) {
    // Open failures are usually transient in dev: a just-killed watch child
    // is still releasing the dir, or a sibling is mid-open. Quarantining on
    // the first failure is what kept "wiping" the local DB — a healthy dir
    // was renamed while its old owner finished closing. Retry for ~2.5s,
    // re-checking for a live holder each pass: a winner appearing mid-loop
    // (another process opened + marked) stops us with a loud error, and a
    // genuinely wedged dir stays unopenable with a dead holder for the
    // whole window before it earns quarantine.
    let lastErr: unknown = err;
    for (let i = 0; i < 10; i++) {
      if (await liveHolder()) throw lastErr;
      await new Promise((r) => setTimeout(r, 250));
      try {
        const db = open();
        await db.execute(sql`select 1`);
        await markOwner();
        return db;
      } catch (e) {
        lastErr = e;
      }
    }
    if (await liveHolder()) throw lastErr;
    const broken = `${env.pgliteDir}.broken-${Date.now()}`;
    console.error(
      `PGlite failed to open ${env.pgliteDir} after retries — quarantining to ${broken}`,
      lastErr,
    );
    await fs.rename(env.pgliteDir, broken).catch(() => {});
    const db = open();
    await markOwner();
    return db;
  }
}

// __drizzle_migrations rows written by hand-crafted journal entries carried
// future `when` values (0063–0067, ms 1790740000000–1791000000000). Drizzle
// applies a migration only when its `when` exceeds the newest recorded
// created_at, so those rows silently skipped every real-timestamped
// migration after them (0067 shipped code without its column once).
// Rewriting the applied rows' created_at below the rewritten journal
// ordering un-poisons the check; exact-value match so real rows can never
// be caught. Idempotent — a no-op once clean.
const POISONED_MIGRATION_STAMPS = [
  1790740000000, 1790790000000, 1790880000000, 1790970000000, 1791000000000,
];
const NORMALIZED_STAMP = 1790720000000;

export async function migrateDb(db: Db) {
  try {
    await db.execute(sql`
      update drizzle.__drizzle_migrations
      set created_at = ${NORMALIZED_STAMP}
      where created_at in (${sql.join(
        POISONED_MIGRATION_STAMPS.map((s) => sql`${s}`),
        sql`, `,
      )})
    `);
  } catch (err) {
    // 42P01 = fresh database — the table is created by migrate() below.
    // Anything else (bad bind, perms) must surface: a silent failure here is
    // exactly how the poisoned ordering went unnoticed once already.
    if ((err as { code?: string }).code !== '42P01') {
      console.error('migration-stamp normalization failed:', err);
    }
  }
  if (env.databaseUrl) {
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    // --max-instances > 1: several instances boot + migrate at once and the
    // loser hits "column already exists". A session-level advisory lock (held
    // on a reserved connection — the pool would scatter it) makes waiters
    // re-check after the winner finishes and find nothing pending. Runs on
    // lockSqlClient — the pooler reissues backends per statement, which both
    // leaks the lock and makes the application_name marker lie.
    if (!lockSqlClient) {
      await migrate(db as never, { migrationsFolder: MIGRATIONS });
      return;
    }
    const conn = await lockSqlClient.reserve();
    try {
      // Identity marker: only migrator sessions may hold this lock. An orphan
      // that the pooler reissued to app traffic shows the app's name, not ours.
      await conn`set application_name = 'janis-migrator'`;
      // Self-heal: a killed migrator (watchdog timeout, pod kill) leaves its
      // backend session holding the lock — Neon's pooler keeps orphaned
      // sessions alive and reissues them to app traffic, where they keep
      // running queries so "idle >5min" never fires. Kill any holder that
      // isn't a live migrator, plus migrator sessions that have outlived a
      // real run (seconds, not minutes).
      await conn`
        select pg_terminate_backend(l.pid) from pg_locks l
        left join pg_stat_activity a on a.pid = l.pid
        where l.locktype = 'advisory' and l.objid = 730062 and l.granted
          and l.pid <> pg_backend_pid()
          and (
            coalesce(a.application_name, '') <> 'janis-migrator'
            or (a.state = 'idle' and a.query_start < now() - interval '5 minutes')
            or a.backend_start < now() - interval '15 minutes'
          )
      `;
      await conn`SELECT pg_advisory_lock(730062)`;
      await migrate(db as never, { migrationsFolder: MIGRATIONS });
    } finally {
      try {
        await conn`SELECT pg_advisory_unlock(730062)`;
      } finally {
        conn.release();
      }
    }
  } else {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(db as never, { migrationsFolder: MIGRATIONS });
  }
}
