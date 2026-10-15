import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { embedEnabled, shopBilling } from '../../src/lib/shopifyApp.js';
const db = await createDb();
for (const shop of ['torontofood.myshopify.com', 'blamp-vzfzgclz.myshopify.com']) {
  const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop)).limit(1);
  const embed = await embedEnabled(db, row).catch((e) => `err: ${e.message}`);
  console.log(shop, '| embedEnabled:', embed, '| billing:', JSON.stringify(shopBilling(row)));
}
process.exit(0);
