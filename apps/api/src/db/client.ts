import type { PgDatabase } from 'drizzle-orm/pg-core';
import { env } from '../env.js';
import * as schema from './schema.js';

// Two drivers, one schema: real Postgres via DATABASE_URL in production,
// embedded PGlite for zero-install local development. The db generic only
// affects query-result plumbing; row types come from the table definitions.
export type Db = PgDatabase<any, any>;

export async function createDb(): Promise<Db> {
  if (env.databaseUrl) {
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { default: postgres } = await import('postgres');
    return drizzle(postgres(env.databaseUrl), { schema }) as unknown as Db;
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  return drizzle(new PGlite(env.pgliteDir), { schema }) as unknown as Db;
}

export async function migrateDb(db: Db) {
  if (env.databaseUrl) {
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    await migrate(db as never, { migrationsFolder: './drizzle' });
  } else {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(db as never, { migrationsFolder: './drizzle' });
  }
}
