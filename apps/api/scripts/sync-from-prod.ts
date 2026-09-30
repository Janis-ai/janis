/** Snapshot prod (Neon) into the local PGlite dev DB. One-way, read-only on
 * the source: selects only, inside a read-only session. The local copy gets
 * sanitized on write so dev can never act as prod:
 *
 *   skipped:   jobs, bus_events, sweeper_locks, voice_queue, sessions,
 *              push_subscriptions, slack_pending_installs, rate_limits,
 *              webhook_deliveries — queues/ephemera; a copied campaign job
 *              WOULD send real outbound from the dev sweeper.
 *   wiped:     every column named *token*, *secret*, or *credential* —
 *              encrypted channel creds use prod's JANIS_SECRETS_KEY anyway,
 *              and cleared creds make every provider call fail-closed.
 *
 * Never run while the dev API holds the PGlite dir — same single-opener rule
 * as everywhere else; the postmaster.pid live-check below refuses.
 *
 *   npm run sync-from-prod -w apps/api
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { sql as dsql } from 'drizzle-orm';
import '../src/loadEnv.js';
import { env } from '../src/env.js';
import * as schema from '../src/db/schema.js';
import { hashPassword } from '../src/lib/crypto.js';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

// Live-fire tables and ephemera that must never come across.
const SKIP = new Set([
  'jobs',
  'bus_events',
  'sweeper_locks',
  'voice_queue',
  'sessions',
  'push_subscriptions',
  'slack_pending_installs',
  'rate_limits',
  'webhook_deliveries',
  'uploads', // storage pointers, blobs live elsewhere
]);

const BATCH = 500;

// DATABASE_URL for prod lives in .env.production — .env is the local file,
// so parse it directly rather than trusting process env.
const prodUrl = (await fs.readFile(new URL('../.env.production', import.meta.url), 'utf8'))
  .match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
if (!prodUrl) throw new Error('no DATABASE_URL in apps/api/.env.production');

// Refuse while a live dev server holds the dir (dead pid = safe to proceed —
// createDb's quarantine handles that case on next boot).
try {
  const pid = Number(
    (await fs.readFile(`${env.pgliteDir}/postmaster.pid`, 'utf8')).split('\n')[0],
  );
  if (pid) {
    process.kill(pid, 0);
    console.error(
      `PGlite dir is held by live pid ${pid} — stop the dev API first ` +
        `(pkill -f "tsx watch src/index.ts").`,
    );
    process.exit(1);
  }
} catch {
  /* ESRCH/no file — no live holder */
}

const { PGlite } = await import('@electric-sql/pglite');
const { drizzle } = await import('drizzle-orm/pglite');
const { migrate } = await import('drizzle-orm/pglite/migrator');
const { default: postgres } = await import('postgres');

// Read-only session: the sync must not be capable of writing to prod.
const src = postgres(prodUrl, {
  max: 1,
  prepare: false,
  connect_timeout: 15,
  connection: { options: '-c default_transaction_read_only=on' },
});
const lite = new PGlite(env.pgliteDir);
const dst = drizzle(lite, { schema });
await migrate(dst as never, { migrationsFolder: MIGRATIONS });

const tableRows = await src`
  select table_name from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
  order by table_name`;
const tables = tableRows.map((r) => r.table_name as string).filter((t) => !SKIP.has(t));
console.log(`copying ${tables.length} tables from prod → ${env.pgliteDir}`);

await dst.execute(dsql`set session_replication_role = 'replica'`); // skip FK order
for (const t of tables) {
  await dst.execute(dsql.raw(`delete from "${t}"`));
  const cols = await src`
    select column_name from information_schema.columns
    where table_schema='public' and table_name=${t}
      and is_generated <> 'ALWAYS'
    order by ordinal_position`;
  const names = cols.map((r) => r.column_name as string);
  // jsonb_populate_recordset maps keys → columns and coerces timestamps,
  // arrays and jsonb natively — no per-type client marshalling.
  for (let off = 0; ; off += BATCH) {
    const rows = await src.unsafe(
      `select to_jsonb(x) as row from (select * from "${t}" order by 1 limit ${BATCH} offset ${off}) x`,
    );
    if (!rows.length) break;
    const payload = JSON.stringify(rows.map((r) => r.row));
    await dst.execute(
      dsql.raw(
        `insert into "${t}" (${names.map((n) => `"${n}"`).join(',')}) ` +
          `select ${names.map((n) => `"${n}"`).join(',')} ` +
          `from jsonb_populate_recordset(null::"${t}", '${payload.replace(/'/g, "''")}'::jsonb)`,
      ),
    );
    if (rows.length < BATCH) break;
  }
  const [c] = await src.unsafe(`select count(*)::int as n from "${t}"`);
  console.log(`  ${t}: ${c.n} rows`);
}

// Blank every token/secret/credential column so copied channels, installs,
// and connections fail-closed instead of acting as prod.
const wipeable = await src`
  select table_name, column_name, data_type from information_schema.columns
  where table_schema='public'
    and column_name ~ '(_token$|_token_enc$|secret|credential)'
    and data_type in ('text', 'jsonb')
    and column_name not in ('password_hash')`;
for (const w of wipeable) {
  const val = w.data_type === 'jsonb' ? `'{}'::jsonb` : `'wiped-local'`;
  await dst.execute(
    dsql.raw(`update "${w.table_name}" set "${w.column_name}" = ${val}`),
  );
}
console.log(`wiped ${wipeable.length} credential-bearing columns locally`);

await dst.execute(dsql`reset session_replication_role`);

// Guarantee a working login even if every prod user is OAuth-only.
const unwrap = (r: unknown) =>
  ((Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows) ?? []) as { id: string }[];
const [admin] = unwrap(
  await dst.execute(dsql`select id from users where email = 'admin@janis.local' limit 1`),
);
let uid = admin?.id;
if (!uid) {
  const [u] = unwrap(
    await dst.execute(
      dsql`insert into users (email, name, password_hash)
           values ('admin@janis.local', 'Local Admin', ${await hashPassword(env.seedAdminPassword)})
           returning id`,
    ),
  );
  uid = u.id;
}
const [ws] = unwrap(await dst.execute(dsql`select id from workspaces limit 1`));
if (ws) {
  await dst.execute(
    dsql`insert into memberships (user_id, workspace_id, role, accepted_at)
         values (${uid}, ${ws.id}, 'admin', now()) on conflict do nothing`,
  );
}
await src.end();
await lite.close();
console.log('done — restart the dev API; log in as admin@janis.local / janis-admin');
process.exit(0);
