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
const lj = await gql(`{locations(first:10){nodes{id name isActive fulfillsOnlineOrders isLocalPickupEnabled hasActiveInventory fulfillmentService{serviceName}}}}`);
console.log('LOCATIONS:', JSON.stringify(lj, null, 1).slice(0, 2500));
const pj = await gql(`{products(first:2,query:"handle:the-videographer-snowboard"){nodes{title status publishedOnCurrentPublication unpublishedChannels(first:5){nodes{publication{name channel{name}}}}}}}`);
console.log('PRODUCT:', JSON.stringify(pj, null, 1).slice(0, 2000));
