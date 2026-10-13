// Read-only check: did the live dev-store install produce a bound shop
// row + mirrored agent secrets? DATABASE_URL must be set (prod read).
import { createDb } from '../../src/db/client.js';
import { shopifyShops, agentSecrets, agents } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';

const shop = process.argv[2] ?? 'janis-store-sx5bpcd3.myshopify.com';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop));
if (!row) {
  console.log('no shopify_shops row for', shop);
  process.exit(1);
}
console.log('shop row:', {
  state: row.state,
  agentId: row.agentId,
  workspaceId: row.workspaceId,
  scopes: row.scopes,
  hasToken: Boolean(row.accessTokenEnc),
});
const [agent] = await db
  .select({ name: agents.name, hosted: agents.hosted })
  .from(agents)
  .where(eq(agents.id, row.agentId!));
console.log('agent:', agent);
const secrets = await db
  .select({ name: agentSecrets.name })
  .from(agentSecrets)
  .where(eq(agentSecrets.agentId, row.agentId!));
console.log('agent secrets:', secrets.map((s) => s.name));
process.exit(0);
