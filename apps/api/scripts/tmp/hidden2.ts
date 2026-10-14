import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const token = decryptSecret(shop!.accessTokenEnc!);
const res = await fetch(`https://${shop!.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `{ products(first: 2, query: "title:*Hidden*") { nodes { id title status variants(first: 3) { nodes { id availableForSale inventoryQuantity requiresSellingPlan } } } } }` }),
});
console.log(JSON.stringify(await res.json(), null, 2).slice(0, 3000));
process.exit(0);
