/** One-off: set a workspace's plan by id.
 *   DATABASE_URL=<prod> npx tsx scripts/tmp/set-workspace-plan.ts <workspace-id> <plan>
 */
import { eq } from 'drizzle-orm';
import { createDb } from '../../src/db/client.js';
import { workspaces } from '../../src/db/schema.js';

const [wsId, plan] = process.argv.slice(2);
if (!wsId || !plan) {
  console.error('usage: set-workspace-plan.ts <workspace-id> <plan>');
  process.exit(1);
}

const db = await createDb();
const [ws] = await db
  .update(workspaces)
  .set({ plan })
  .where(eq(workspaces.id, wsId))
  .returning({ id: workspaces.id, name: workspaces.name, plan: workspaces.plan });
console.log(ws ?? 'no such workspace');
process.exit(0);
