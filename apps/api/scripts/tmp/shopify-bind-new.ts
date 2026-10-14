import { createDb } from '../../src/db/client.js';
import { agents, shopifyShops } from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { bindShop } from '../../src/lib/shopifyApp.js';

const SHOP = 'torontofood.myshopify.com';
const AGENT = 'd408d7b5-fdad-49a4-a34d-11fa16e88135';

const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, SHOP)).limit(1);
if (!row) throw new Error(`no shop row for ${SHOP} — open the app in the store admin first`);
const [a] = await db.select({ workspaceId: agents.workspaceId }).from(agents).where(eq(agents.id, AGENT)).limit(1);
if (!a) throw new Error('agent not found');

await bindShop(db, row, { workspaceId: a.workspaceId, agentId: AGENT });
// The agent's catalog secrets now point at torontofood — the old store's
// binding would serve the wrong catalog on its storefront; unlink it.
await db
  .update(shopifyShops)
  .set({ state: 'unlinked', updatedAt: new Date() })
  .where(and(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'), eq(shopifyShops.state, 'linked')));
console.log('bound', SHOP, '→', AGENT, '| old store unlinked');
process.exit(0);
