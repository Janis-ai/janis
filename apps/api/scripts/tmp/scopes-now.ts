import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { adminToken } from '../../src/lib/shopifyToken.js';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const [s] = await db.select().from(schema.shopifyShops).where(eq(schema.shopifyShops.shop, 'torontofood.myshopify.com'));
const tok = await adminToken(db as never, s as never);
const r = await fetch('https://torontofood.myshopify.com/admin/api/2026-10/graphql.json', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': tok },
  body: JSON.stringify({ query: `{appInstallation{accessScopes{handle}}}` }) });
console.log(JSON.stringify(await r.json(), null, 1));
await sql.end();
