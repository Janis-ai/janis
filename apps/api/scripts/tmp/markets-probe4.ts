import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { adminToken } from '../../src/lib/shopifyToken.js';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const [s] = await db.select().from(schema.shopifyShops).where(eq(schema.shopifyShops.shop, 'torontofood.myshopify.com'));
const tok = await adminToken(db as never, s as never);
const gql = async (query: string) => {
  const r = await fetch('https://torontofood.myshopify.com/admin/api/2026-10/graphql.json', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': tok },
    body: JSON.stringify({ query }) });
  return r.json() as Promise<Record<string, unknown>>;
};
const m = await gql(`{markets(first:10){nodes{id name primary enabled regions(first:10){nodes{name}} catalogs(first:5){nodes{id title status}}}}}`);
console.log(JSON.stringify(m.data ?? m, null, 1).slice(0, 4000));
await sql.end();
