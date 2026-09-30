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

// Raw postgres-js client, kept for the advisory lock that serializes
// migrations across concurrent Cloud Run instance boots.
let sqlClient: { reserve(): Promise<ReservedSql> } | null = null;
type ReservedSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  release(): void;
};

export async function createDb(): Promise<Db> {
  if (env.databaseUrl) {
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { default: postgres } = await import('postgres');
    const sql = postgres(env.databaseUrl, {
      max: env.dbPoolMax,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    sqlClient = sql as never;
    return drizzle(sql, { schema }) as unknown as Db;
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  return drizzle(new PGlite(env.pgliteDir), { schema }) as unknown as Db;
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
    // re-check after the winner finishes and find nothing pending.
    if (!sqlClient) {
      await migrate(db as never, { migrationsFolder: MIGRATIONS });
      return;
    }
    const conn = await sqlClient.reserve();
    try {
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
