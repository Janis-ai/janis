import { createDb } from '../../src/db/client.js';
import { shopifyShops, messages } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { adminToken } from '../../src/lib/shopifyToken.js';

const db = await createDb();
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'blamp-vzfzgclz.myshopify.com'));
// market field on the inbound messages
const inbound = await db.select({ text: messages.text, payload: messages.payload, createdAt: messages.createdAt })
  .from(messages).where(eq(messages.conversationId, 'ade8ec3a-fef2-4530-b387-856c0cace362')).orderBy(desc(messages.createdAt)).limit(6);
for (const m of inbound) console.log(m.direction ?? m.createdAt.toISOString().slice(11,19), (m.text??'').slice(0,60), 'market=', (m.payload as any)?.market);

const token = await adminToken(db, shop);
const gql = async (q: string) => (await (await fetch(`https://${shop.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
  body: JSON.stringify({ query: q }),
})).json()) as any;

const disc = await gql(`{ automaticDiscountNodes(first:10){ nodes { automaticDiscount { ... on DiscountAutomaticBasic { title status } ... on DiscountAutomaticBxgy { title status } } } } }`);
console.log('discounts:', JSON.stringify(disc.data?.automaticDiscountNodes?.nodes ?? disc, null, 1).slice(0, 800));
const markets = await gql(`{ markets(first:10){ nodes { name primary enabled priceList { id } catalogs(first:1){totalCount} } } }`);
console.log('markets:', JSON.stringify(markets.data?.markets?.nodes ?? markets, null, 1).slice(0, 1200));
const shopInfo = await gql(`{ shop { currencyCode ianaTimezone } }`);
console.log('shop:', JSON.stringify(shopInfo.data?.shop));
process.exit(0);
