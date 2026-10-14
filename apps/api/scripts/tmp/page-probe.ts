import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const token = decryptSecret(shop!.accessTokenEnc!);
const gql = async (q: string, after: string | null) => {
  const res = await fetch(`https://${shop!.shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query($q:String!,$after:String){productsCount(query:$q){count} products(first:12,query:$q,after:$after){pageInfo{hasNextPage endCursor} nodes{title}}}', variables: { q, after } }),
  });
  return res.json();
};
const p1 = await gql(' status:active published_status:published', null);
console.log('p1:', p1.data.products.nodes.length, 'nodes | hasNext:', p1.data.products.pageInfo.hasNextPage);
const p2 = await gql(' status:active published_status:published', 'eyJsYXN0X3ZhbHVlIjoiNzg2ODk4MDIxNzA5MyIsImlkIjo3ODY4OTgwMjE3MDkzfQ==');
console.log('p2:', p2.data?.products?.nodes?.map((n:any)=>n.title) ?? JSON.stringify(p2).slice(0,300));
process.exit(0);
