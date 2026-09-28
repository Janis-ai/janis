/**
 * Copy the whole PGlite database into real Postgres — the Cloud SQL cutover.
 *
 *   # 1. snapshot the FUSE-mounted prod data (source of truth while PGlite runs)
 *   gcloud storage rsync -r gs://janis-data-PROJECT/pglite /tmp/janis-pglite
 *
 *   # 2. run the copy (target must be reachable — use the auth proxy locally:
 *   #    cloud-sql-proxy PROJECT:REGION:INSTANCE)
 *   DATABASE_URL='postgres://user:pass@127.0.0.1:5432/janis' \
 *     PGLITE_DIR=/tmp/janis-pglite npm run migrate-to-pg -w apps/api -- --apply
 *
 * How it works: migrates the target schema first, then copies every public
 * table verbatim with FK checks deferred (session_replication_role — the
 * Cloud SQL postgres user may set it). Idempotent — existing rows are skipped
 * via ON CONFLICT DO NOTHING, so re-running catches writes that landed during
 * the copy. Cutover = stop writes → final run → redeploy with DATABASE_URL.
 */
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { env } from '../src/env.js';

const apply = process.argv.includes('--apply');
const target = process.env.DATABASE_URL;
if (!target) {
  console.error('DATABASE_URL required — set it to the Postgres connection string');
  process.exit(1);
}
if (!env.pgliteDir) {
  console.error('PGLITE_DIR required — point it at the source data dir');
  process.exit(1);
}

const { PGlite } = await import('@electric-sql/pglite');
const { drizzle } = await import('drizzle-orm/pglite');
const src = drizzle(new PGlite(env.pgliteDir));
const dst = postgres(target, { prepare: false });

const BATCH = 500;
const tableName = (t: string) => sql.raw(`"${t}"`);

async function count(db: typeof src, t: string): Promise<number> {
  const res = (await db.execute(sql`select count(*)::int as n from ${tableName(t)}`)) as unknown;
  const rows = (res as { rows?: { n: number }[] }).rows ?? (res as { n: number }[]);
  return rows[0].n;
}

async function main() {
  // Run schema migrations on the target first so every table exists
  const { createDb, migrateDb } = await import('../src/db/client.js');
  await migrateDb(await createDb());

  const res = (await src.execute(
    sql`select tablename from pg_tables where schemaname = 'public' order by tablename`,
  )) as { rows?: { tablename: string }[] };
  const names = (res.rows ?? []).map((t) => t.tablename);
  console.log(`${names.length} tables ${apply ? '(APPLY)' : '(dry run — pass --apply to write)'}`);

  await dst`set session_replication_role = 'replica'`; // suspend FK checks
  try {
    for (const t of names) {
      const out = (await src.execute(sql`select * from ${tableName(t)}`)) as {
        rows?: Record<string, unknown>[];
      };
      const rows = out.rows ?? [];
      if (!rows.length || !apply) {
        console.log(`${t}: ${rows.length} rows${apply ? '' : ' (skipped)'}`);
        continue;
      }
      for (let i = 0; i < rows.length; i += BATCH) {
        await dst`insert into ${dst(t)} ${dst(rows.slice(i, i + BATCH))} on conflict do nothing`;
      }
      console.log(`${t}: ${rows.length} rows copied`);
    }
  } finally {
    await dst`set session_replication_role = 'origin'`;
  }

  // Parity check — row counts should match table for table
  let drift = 0;
  for (const t of names) {
    const a = await count(src, t);
    const [b] = await dst`select count(*)::int as n from ${dst(t)}`;
    if (a !== b.n) {
      console.log(`  ⚠ ${t}: source=${a} target=${b.n}`);
      drift++;
    }
  }
  console.log(drift ? `${drift} tables differ` : 'all counts match');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
