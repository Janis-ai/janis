import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { adminToken } from '../../src/lib/shopifyToken.js';

const db = await createDb();
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'blamp-vzfzgclz.myshopify.com'));
const token = await adminToken(db, shop);
const gql = async (q: string) => (await (await fetch(`https://${shop.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
  body: JSON.stringify({ query: q }),
})).json()) as any;

const markets = await gql(`{ markets(first:10){ nodes { name primary enabled conditions priceList { id parent { adjustment { type value } pricesCount } } } } }`);
console.log(JSON.stringify(markets.data?.markets ?? markets, null, 1).slice(0, 2000));
process.exit(0);
