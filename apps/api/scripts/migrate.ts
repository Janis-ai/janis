/** Pre-deploy migration runner — deploy-gcp.sh invokes this with DATABASE_URL
 *  set so the schema is current before new Cloud Run instances boot (they run
 *  with SKIP_DB_MIGRATE=1). Safe to re-run: drizzle migrations are idempotent
 *  and the advisory lock serializes any overlap with a still-migrating boot.
 *
 *  PGlite guard: two processes opening the same PGlite dir corrupts it
 *  (this script once raced a live dev server and bricked ~/.janis/pglite —
 *  initdb aborts on the half-initialized dir forever after). postmaster.pid
 *  can't distinguish live from stale, so instead of guessing, this script
 *  is DATABASE_URL-only: local PGlite already migrates at boot. */
import '../src/loadEnv.js';
import { env } from '../src/env.js';
import { createDb, migrateDb } from '../src/db/client.js';

if (!env.databaseUrl) {
  console.error(
    'db:migrate only runs against DATABASE_URL deployments — local PGlite ' +
      'migrates at boot, and a second opener would corrupt the data dir.',
  );
  process.exit(1);
}

// Hard watchdog: postgres.js's connect_timeout covers the handshake only —
// a query on a half-dead socket (Neon suspended the TCP mid-migration once,
// deploy sat 20+ min waiting on an event loop with no sockets) hangs forever.
// deploy-gcp.sh must fail loud, not stall the pipeline.
const watchdog = setTimeout(() => {
  console.error('db:migrate timed out after 120s — aborting deploy');
  process.exit(2);
}, 120_000);

const db = await createDb();
await migrateDb(db);
clearTimeout(watchdog);
console.log('migrations applied');
process.exit(0);
