import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const token = decryptSecret(shop!.accessTokenEnc!);
const q = 'title:*Hidden* status:active published_status:published';
const res = await fetch(`https://${shop!.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'query($q:String!){products(first:5,query:$q){nodes{title}}}', variables: { q } }),
});
const j = await res.json();
console.log('hidden ask →', JSON.stringify(j.data?.products?.nodes?.map((n:any)=>n.title) ?? j));
const q2 = ' status:active published_status:published';
const res2 = await fetch(`https://${shop!.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'query($q:String!){productsCount(query:$q){count} products(first:15,query:$q){nodes{title}}}', variables: { q: q2 } }),
});
const j2 = await res2.json();
console.log('browse →', j2.data?.productsCount?.count, '|', (j2.data?.products?.nodes ?? []).map((n:any)=>n.title).join(', '));
process.exit(0);
