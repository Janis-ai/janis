import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';
const shop = 'janis-store-sx5bpcd3.myshopify.com';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop));
const token = decryptSecret(row!.accessTokenEnc);
const gql = async (q: string, v?: unknown) =>
  (await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query: q, variables: v }),
  })).json();
// full enum via intentional-bad sort
const bad = await gql('query($s:ProductSortKeys){products(first:1,sortKey:$s){nodes{id}}}', { s: 'ZZZ' });
console.log('enum list:', JSON.stringify((bad as any).errors?.[0]?.extensions?.problems ?? bad).slice(0, 600));
// does Collection.products accept BEST_SELLING?
const col = await gql('query($h:String!){collectionByHandle(handle:$h){products(first:5,sortKey:BEST_SELLING){nodes{title}}}}', { h: 'hydrogen' });
console.log('collection BEST_SELLING:', JSON.stringify(col).slice(0, 400));
process.exit(0);
