import { createDb } from '../../src/db/client.js';
import { channels, agents, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
for (const shop of ['torontofood.myshopify.com', 'blamp-vzfzgclz.myshopify.com']) {
  const [s] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop)).limit(1);
  if (!s?.agentId) continue;
  const chans = await db.select().from(channels).where(eq(channels.agentId, s.agentId));
  const [ag] = await db.select().from(agents).where(eq(agents.id, s.agentId)).limit(1);
  console.log(shop, '| agent', ag?.name, '| plan ws', s.workspaceId?.slice(0,8));
  for (const ch of chans) {
    const creds = ch.credentials as Record<string, unknown>;
    console.log('   ', ch.id, ch.kind, ch.name, 'internal=' + creds.internal);
  }
}
process.exit(0);
