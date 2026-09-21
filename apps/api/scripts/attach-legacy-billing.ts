/**
 * Backfill agents.metadata.legacy_stripe from a client_key → Stripe linkage
 * map (produced from wordhopapi slack_integrations).
 *
 *   DATABASE_URL=… npx tsx scripts/attach-legacy-billing.ts --file legacy-billing.json
 */
import { createDb } from '../src/db/client.js';
import { agents } from '../src/db/schema.js';
import { sql, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args[args.indexOf('--file') + 1];
if (!file) {
  console.error('usage: --file legacy-billing.json');
  process.exit(1);
}
const map = JSON.parse(readFileSync(file, 'utf8')) as Record<
  string,
  { customer_id?: string; subscription_id?: string; plan?: string; meter_item_id?: string }
>;

const db = await createDb();
const rows = await db
  .select({ id: agents.id, name: agents.name, key: sql<string>`metadata->>'legacy_client_key'`, meta: agents.metadata })
  .from(agents)
  .where(sql`metadata->>'legacy_client_key' is not null`);

let updated = 0;
for (const a of rows) {
  const link = a.key ? map[a.key] : undefined;
  if (!link?.subscription_id) continue;
  const meta = { ...(a.meta as Record<string, unknown>), legacy_stripe: link };
  await db.update(agents).set({ metadata: meta }).where(eq(agents.id, a.id));
  console.log(' linked:', a.name, '→', link.plan, link.subscription_id);
  updated++;
}
console.log(`done: ${updated}/${rows.length} agents got legacy_stripe`);
process.exit(0);
