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
const pj = await gql(`{products(first:5,query:"handle:the-videographer-snowboard OR handle:the-complete-snowboard"){nodes{title status publishedOnCurrentPublication requiresSellingPlan resourcePublicationsV2(first:10){nodes{isPublished publication{name}}} variants(first:2){nodes{inventoryItem{tracked} sellableOnlineQuantity}}}}}`);
console.log(JSON.stringify(pj.data ?? pj, null, 1).slice(0, 4500));
