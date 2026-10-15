import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { adminToken } from '../../src/lib/shopifyToken.js';

const db = await createDb();
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'blamp-vzfzgclz.myshopify.com'));
const token = await adminToken(db, shop);
const res = await fetch(`https://${shop.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
  body: JSON.stringify({ query: `{
    products(first: 20) { nodes { title handle totalVariants variants(first:10){ nodes { id title price } } priceRangeV2{ minVariantPrice{amount} maxVariantPrice{amount} } } }
  }` }),
});
const json = await res.json();
for (const p of json.data.products.nodes) {
  console.log(p.title, '|', p.handle, '| variants:', p.totalVariants, '| range:', JSON.stringify(p.priceRangeV2));
  for (const v of p.variants.nodes) console.log('   ', v.id.split('/').pop(), v.title, '$'+v.price);
}
process.exit(0);
