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
  body: JSON.stringify({ query: `{ products(first: 2, query: "title:*Hidden*") { nodes { id title status publishedOnCurrentPublication variants(first: 3) { nodes { id availableForSale inventoryQuantity sellingPlanGroups(first:1) { nodes { name } } } } } } }` }),
});
const json = await res.json();
console.log(JSON.stringify(json.data ?? json, null, 2).slice(0, 3000));
// Now simulate the storefront add-to-cart — what does /cart/add.js say for this variant?
const ac = await fetch(`https://${shop!.shop}/cart/add.js`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items: [{ id: 54223607300379, quantity: 1 }] }),
});
console.log('add.js status:', ac.status, await ac.text());
process.exit(0);
