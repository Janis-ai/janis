import { fileURLToPath } from 'node:url';
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
    const sql = postgres(env.databaseUrl);
    sqlClient = sql as never;
    return drizzle(sql, { schema }) as unknown as Db;
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  return drizzle(new PGlite(env.pgliteDir), { schema }) as unknown as Db;
}

export async function migrateDb(db: Db) {
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
