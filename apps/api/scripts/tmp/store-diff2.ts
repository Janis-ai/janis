import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const rows = await db.select().from(schema.shopifyShops);
await sql.end();
for (const shop of ['janis-store-sx5bpcd3.myshopify.com', 'janis-inc.myshopify.com']) {
  console.log('===', shop, '===');
  const pj = await fetch(`https://${shop}/products.json?limit=5`, { headers: { 'user-agent': 'Mozilla/5.0' }, redirect: 'manual' });
  console.log('  products.json →', pj.status, (await pj.text()).slice(0, 200));
}
// janis-inc token has read_markets — dig the market → catalog binding
const inc = rows.find((r) => r.shop === 'janis-inc.myshopify.com')!;
const tok = decryptSecret(inc.accessTokenEnc!);
const g = (q: string) => fetch(`https://janis-inc.myshopify.com/admin/api/2026-10/graphql.json`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': tok },
  body: JSON.stringify({ query: q }) }).then((r) => r.json() as Promise<Record<string, unknown>>);
const mk = await g(`{markets(first:10){nodes{id name primary enabled catalogs(first:5){nodes{id title status}}}}}`);
console.log('inc markets:', JSON.stringify((mk as {data?:unknown}).data ?? mk, null, 1).slice(0, 2500));
