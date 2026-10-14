import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'torontofood.myshopify.com')).limit(1);
const token = decryptSecret(row!.accessTokenEnc!);
const r = await fetch(`https://${row!.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': token, 'content-type': 'application/json' },
  body: JSON.stringify({ query: `{ shop { name } productsCount { count } products(first: 20) { nodes { title productType status } } }` }),
});
console.log(r.status, JSON.stringify(await r.json(), null, 1).slice(0, 2000));
process.exit(0);
