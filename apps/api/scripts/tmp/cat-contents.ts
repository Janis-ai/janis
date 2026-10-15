import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const rows = await db.select().from(schema.shopifyShops);
await sql.end();
const inc = rows.find((r) => r.shop === 'janis-inc.myshopify.com')!;
const tok = decryptSecret(inc.accessTokenEnc!);
const g = (q: string) => fetch(`https://janis-inc.myshopify.com/admin/api/2026-10/graphql.json`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': tok },
  body: JSON.stringify({ query: q }) }).then((r) => r.json() as Promise<Record<string, unknown>>);
const c = await g(`{catalog(id:"gid://shopify/MarketCatalog/170949116203"){title status publication{id products(first:10){nodes{title}}}}}`);
console.log(JSON.stringify(c.data ?? c, null, 1).slice(0, 2500));
