import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { shopifyCollectionId } from '../../src/lib/widgets.js';
import { eq } from 'drizzle-orm';

const shop = 'janis-store-sx5bpcd3.myshopify.com';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop));
const token = decryptSecret(row!.accessTokenEnc);
const secrets = { SHOPIFY_SHOP: shop, SHOPIFY_TOKEN: token };

console.log('resolve hydrogen ->', await shopifyCollectionId(secrets, 'hydrogen'));
console.log('resolve bogus ->', await shopifyCollectionId(secrets, 'nope-collection'));

const gql = async (q: string, v?: unknown) =>
  (await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query: q, variables: v }),
  })).json();

const r = await gql(
  'query($q:String!){productsCount(query:$q){count} products(first:12,query:$q){nodes{title}}}',
  { q: ' collection_id:' + (await shopifyCollectionId(secrets, 'hydrogen')) + ' status:active published_status:published' },
);
console.log('scoped search:', JSON.stringify(r.data?.productsCount), JSON.stringify(r.data?.products?.nodes?.map((n:any)=>n.title)));
const z = await gql(
  'query($q:String!){productsCount(query:$q){count}}',
  { q: ' collection_id:0 status:active published_status:published' },
);
console.log('bogus-id search:', JSON.stringify(z.data?.productsCount));
process.exit(0);
