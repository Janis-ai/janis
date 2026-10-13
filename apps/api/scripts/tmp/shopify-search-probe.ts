import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [shop] = await db.select().from(shopifyShops)
  .where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const token = decryptSecret(shop!.accessTokenEnc!);
const gql = async (q: string, vars: any) => {
  const res = await fetch(`https://${shop!.shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query: q, variables: vars }),
  });
  return res.json();
};
const Q = 'query($q:String!){products(first:8,query:$q){nodes{title}}}';
for (const q of ['status:active title:**', 'status:active title:*a*', 'status:active', 'status:active title:*snowboard*']) {
  const r: any = await gql(Q, { q });
  console.log(JSON.stringify(q), '→', r.errors ? JSON.stringify(r.errors).slice(0,200) : r.data.products.nodes.map((n:any)=>n.title).join(', '));
}
process.exit(0);
