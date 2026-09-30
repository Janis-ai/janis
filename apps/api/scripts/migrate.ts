/** Pre-deploy migration runner — deploy-gcp.sh invokes this with DATABASE_URL
 *  set so the schema is current before new Cloud Run instances boot (they run
 *  with SKIP_DB_MIGRATE=1). Safe to re-run: drizzle migrations are idempotent
 *  and the advisory lock serializes any overlap with a still-migrating boot. */
import '../src/loadEnv.js';
import { createDb, migrateDb } from '../src/db/client.js';

const db = await createDb();
await migrateDb(db);
console.log('migrations applied');
