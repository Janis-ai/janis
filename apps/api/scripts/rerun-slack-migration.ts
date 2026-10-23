/**
 * Re-run the self-serve Slack migration for a team — idempotent backfill for
 * a partially-migrated install (e.g. a team migrated before agent import
 * shipped, or a step that failed mid-run). The pending grant is gone by then,
 * so the pending shape is synthesized from the live install.
 *
 *   DATABASE_URL=… LEGACY_MONGODB_URI=… npx tsx scripts/rerun-slack-migration.ts --team TN1965J9M
 */
import '../src/loadEnv.js';
import { eq } from 'drizzle-orm';
import { createDb, migrateDb } from '../src/db/client.js';
import { slackInstallations } from '../src/db/schema.js';
import { runSlackMigration } from '../src/lib/slackMigration.js';

const teamId = process.argv[process.argv.indexOf('--team') + 1];
if (!process.argv.includes('--team') || !teamId) {
  console.error('usage: --team <slack team id>');
  process.exit(1);
}

const db = await createDb();
await migrateDb(db);
const [inst] = await db
  .select()
  .from(slackInstallations)
  .where(eq(slackInstallations.teamId, teamId))
  .limit(1);
if (!inst) {
  console.error(`no slack_installations row for ${teamId} — nothing to re-migrate`);
  process.exit(1);
}
const stats = await runSlackMigration(
  db,
  {
    teamId: inst.teamId,
    teamName: inst.teamName,
    botToken: inst.botToken,
    installerSlackUserId: inst.installerSlackUserId,
    installerUserToken: inst.installerUserToken,
  },
  inst.workspaceId,
  inst.installerUserId,
);
console.log('migration re-run:', JSON.stringify(stats));
process.exit(0);
