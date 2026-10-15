import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const rows = await db.select().from(schema.shopifyShops);
await sql.end();
for (const r of rows) {
  console.log(r.shop, '| state:', r.state, '| hasToken:', Boolean(r.accessTokenEnc));
}
const old = rows.find((r) => r.shop === 'janis-store-sx5bpcd3.myshopify.com');
if (old?.accessTokenEnc) {
  const tok = decryptSecret(old.accessTokenEnc);
  const r = await fetch('https://janis-store-sx5bpcd3.myshopify.com/admin/api/2026-10/graphql.json', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': tok },
    body: JSON.stringify({ query: '{shop{name}}' }) });
  console.log('old store API →', r.status, (await r.text()).slice(0, 200));
}
