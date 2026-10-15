import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const [s] = await db.select().from(schema.shopifyShops).where(eq(schema.shopifyShops.shop, 'torontofood.myshopify.com'));
await sql.end();
const tok = decryptSecret(s.accessTokenEnc!);
const gql = async (query: string) => {
  const r = await fetch('https://torontofood.myshopify.com/admin/api/2026-10/graphql.json', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': tok },
    body: JSON.stringify({ query }) });
  return r.json() as Promise<Record<string, unknown>>;
};
for (const [label, id] of [['ONLINE STORE', 'gid://shopify/AppCatalog/176171811138'], ['CANADA MARKET', 'gid://shopify/MarketCatalog/176171942210']] as const) {
  const c = await gql(`{catalog(id:"${id}"){id title status operations{__typename ... on AddProductsOperation{products(first:20){nodes{title}}} ... on RemoveProductsOperation{products(first:20){nodes{title}}} ... on PriceOperation{pricings(first:5){price{amount}}}}}}`);
  console.log(label, JSON.stringify(c, null, 1).slice(0, 2000));
}
