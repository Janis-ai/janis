/**
 * Set a workspace's plan directly (comping, internal accounts, support fixes).
 *
 *   npm run set-plan -w apps/api -- --email user@x.com --plan internal
 *   npm run set-plan -w apps/api -- --workspace <id> --plan pro
 *
 * For prod: DATABASE_URL=postgres://… npx tsx scripts/set-plan.ts --email … --plan internal
 */
import '../src/loadEnv.js';
import { eq } from 'drizzle-orm';
import { createDb, migrateDb } from '../src/db/client.js';
import { users, workspaces } from '../src/db/schema.js';
import { PLANS } from '../src/lib/plans.js';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const plan = opt('plan');
const email = opt('email');
const wsId = opt('workspace');
const list = args.includes('--list');

const db = await createDb();
await migrateDb(db);

if (list) {
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name, plan: workspaces.plan, email: users.email })
    .from(workspaces)
    .leftJoin(users, eq(users.workspaceId, workspaces.id));
  for (const r of rows) console.log(`${r.id}  ${r.plan ?? '-'}  ${r.name ?? '-'}  ${r.email ?? ''}`);
  process.exit(0);
}

if (!plan || !PLANS[plan]) {
  console.error(`--plan must be one of: ${Object.keys(PLANS).join(', ')}`);
  process.exit(1);
}

let ws;
if (wsId) {
  [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId)).limit(1);
} else if (email) {
  const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (u) [ws] = await db.select().from(workspaces).where(eq(workspaces.id, u.workspaceId)).limit(1);
}
if (!ws) {
  console.error('workspace not found (use --list to see all)');
  process.exit(1);
}

await db.update(workspaces).set({ plan }).where(eq(workspaces.id, ws.id));
console.log(`${ws.name ?? ws.id}: ${ws.plan ?? 'free'} → ${plan}`);
process.exit(0);
