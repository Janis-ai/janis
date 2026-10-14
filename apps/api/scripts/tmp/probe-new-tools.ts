import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';

const shop = 'janis-store-sx5bpcd3.myshopify.com';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop));
const token = decryptSecret(row!.accessTokenEnc);

const gql = async (query: string, variables?: unknown) => {
  const res = await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
};

// 1. collections tool query — verbatim from the new bodyTemplate
const cols = await gql('{collectionsCount{count} collections(first:25){nodes{id title handle descriptionHtml(truncateAt:120) image{url} productsCount{count}}}}');
console.log('collections:', JSON.stringify(cols).slice(0, 700));

// 2. search with collection clause + sort/reverse variables
const search = await gql(
  'query($q:String!,$after:String,$sort:ProductSortKeys,$reverse:Boolean){productsCount(query:$q){count} products(first:12,query:$q,after:$after,sortKey:$sort,reverse:$reverse){pageInfo{hasNextPage endCursor} nodes{title}}}',
  { q: ' collection:hydrogen status:active published_status:published', after: null, sort: 'TITLE', reverse: null },
);
console.log('collection+sort search:', JSON.stringify(search).slice(0, 500));

// 3. sales stats query — verbatim
const stats = await gql('{ordersCount{count} orders(first:50,sortKey:CREATED_AT,reverse:true){nodes{name createdAt displayFinancialStatus displayFulfillmentStatus lineItems(first:20){nodes{quantity title product{title handle}}}}}}');
console.log('sales stats:', JSON.stringify(stats).slice(0, 400));
process.exit(0);
