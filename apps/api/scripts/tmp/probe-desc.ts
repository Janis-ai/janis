import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [shop] = await db.select().from(shopifyShops)
  .where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const token = decryptSecret(shop!.accessTokenEnc!);
const Q = 'query($q:String!){products(first:8,query:$q){nodes{id title handle vendor productType description(truncateAt:280) featuredImage{url} variants(first:1){nodes{price}} priceRangeV2{minVariantPrice{amount currencyCode}}}}}';
const r: any = await fetch(`https://${shop!.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
  body: JSON.stringify({ query: Q, variables: { q: 'status:active title:*hidden*' } }),
}).then((x) => x.json());
if (r.errors) console.log('ERRORS:', JSON.stringify(r.errors).slice(0, 600));
else console.log(JSON.stringify(r.data.products.nodes.map((n: any) => ({ title: n.title, type: n.productType, desc: n.description })), null, 2));
process.exit(0);
