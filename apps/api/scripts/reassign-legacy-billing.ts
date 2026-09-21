/**
 * Re-point an imported legacy agent's Stripe linkage to a different legacy
 * subscription (e.g. moving a bot off the owner's account onto the real
 * customer's). Usage: DATABASE_URL=… npx tsx scripts/reassign-legacy-billing.ts
 *   --key <legacy_client_key> --customer cus_… --sub sub_… [--meter si_…] [--plan X]
 */
import { createDb } from '../src/db/client.js';
import { agents } from '../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';

const args = process.argv.slice(2);
const get = (f: string) => args[args.indexOf(f) + 1];
const key = get('--key');
const customer = get('--customer');
const sub = get('--sub');
const meter = args.includes('--meter') ? get('--meter') : undefined;
const plan = args.includes('--plan') ? get('--plan') : undefined;
if (!key || !customer || !sub) {
  console.error('usage: --key <client_key> --customer <cus_…> --sub <sub_…> [--meter si_…] [--plan X]');
  process.exit(1);
}

const db = await createDb();
const [agent] = await db
  .select()
  .from(agents)
  .where(sql`metadata->>'legacy_client_key' = ${key}`)
  .limit(1);
if (!agent) {
  console.error('no agent with that legacy_client_key');
  process.exit(1);
}
const metadata = {
  ...(agent.metadata as Record<string, unknown>),
  legacy_stripe: {
    customer_id: customer,
    subscription_id: sub,
    ...(meter ? { meter_item_id: meter } : {}),
    ...(plan ? { plan } : {}),
  },
};
await db.update(agents).set({ metadata }).where(eq(agents.id, agent.id));
console.log(`reassigned ${agent.name} (${agent.id}) → ${customer}/${sub}`);
process.exit(0);
