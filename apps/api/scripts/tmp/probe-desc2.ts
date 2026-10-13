import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [shop] = await db.select().from(shopifyShops)
  .where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const token = decryptSecret(shop!.accessTokenEnc!);
const Q = 'query($q:String!){products(first:8,query:$q){nodes{title tags options{name values} variants(first:5){nodes{title price inventoryQuantity}}}}}';
const r: any = await fetch(`https://${shop!.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
  body: JSON.stringify({ query: Q, variables: { q: 'status:active title:*hidden*' } }),
}).then((x) => x.json());
console.log(JSON.stringify(r.data?.products?.nodes ?? r.errors, null, 2).slice(0, 2000));
process.exit(0);
