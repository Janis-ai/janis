import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';

const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'torontofood.myshopify.com')).limit(1);
if (!row?.accessTokenEnc) throw new Error('no token');
const token = decryptSecret(row.accessTokenEnc);
const r = await fetch(`https://${row.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': token, 'content-type': 'application/json' },
  body: JSON.stringify({
    query: `{ productsCount { count } products(first: 20) { nodes { title productType status } } shop { plan { partnerDevelopment } } }`,
  }),
});
const j = (await r.json()) as any;
console.log('count:', j.data?.productsCount?.count, '| dev store:', j.data?.shop?.plan?.partnerDevelopment);
for (const p of j.data?.products?.nodes ?? []) console.log(' -', p.title, '|', p.productType, '|', p.status);
process.exit(0);
