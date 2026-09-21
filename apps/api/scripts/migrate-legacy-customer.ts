/**
 * Move every imported legacy agent billed to a Stripe customer into its own
 * workspace, with an admin user who can sign in (Google OAuth matches on
 * email; set a password later if they need password login).
 *
 * The workspace gets plan 'internal' ($0, uncapped) — their payment keeps
 * flowing through the legacy per-agent subscription (metadata.legacy_stripe),
 * not the new app's plan billing, so no double-charge and no free-tier cap.
 *
 * Usage: DATABASE_URL=… npx tsx scripts/migrate-legacy-customer.ts
 *   --customer cus_… --ws-name "Acme" --email a@b.com --user-name "A Person" [--apply]
 * Dry-run unless --apply is passed.
 */
import { createDb } from '../src/db/client.js';
import { agents, channels, users, workspaces } from '../src/db/schema.js';
import { inArray, sql } from 'drizzle-orm';

const args = process.argv.slice(2);
const get = (f: string) => args[args.indexOf(f) + 1];
const customer = get('--customer');
const wsName = get('--ws-name');
const email = get('--email');
const userName = get('--user-name') ?? wsName;
const apply = args.includes('--apply');
if (!customer || !wsName || !email) {
  console.error('usage: --customer cus_… --ws-name "X" --email a@b.com [--user-name "X"] [--apply]');
  process.exit(1);
}

const db = await createDb();

const rows = await db
  .select({ id: agents.id, name: agents.name, workspaceId: agents.workspaceId })
  .from(agents)
  .where(sql`metadata->'legacy_stripe'->>'customer_id' = ${customer}`);

if (!rows.length) {
  console.error(`no agents with legacy_stripe.customer_id = ${customer}`);
  process.exit(1);
}

console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${rows.length} agents → workspace "${wsName}" <${email}>:`);
for (const r of rows) console.log(`  ${r.name} (${r.id})`);
if (!apply) {
  console.log('pass --apply to execute');
  process.exit(0);
}

await db.transaction(async (tx) => {
  const [ws] = await tx
    .insert(workspaces)
    .values({ name: wsName, plan: 'internal' })
    .returning();
  const [user] = await tx
    .insert(users)
    .values({ workspaceId: ws.id, email, name: userName, role: 'admin' })
    .onConflictDoNothing()
    .returning();
  if (!user) {
    throw new Error(`user ${email} already exists — refusing to guess their workspace`);
  }
  const ids = rows.map((r) => r.id);
  await tx.update(agents).set({ workspaceId: ws.id }).where(inArray(agents.id, ids));
  // channels carry their own workspace_id for the console's scoping
  await tx
    .update(channels)
    .set({ workspaceId: ws.id })
    .where(inArray(channels.agentId, ids));
  console.log(`workspace ${ws.id} | user ${user.id} | moved ${ids.length} agents`);
});
process.exit(0);
