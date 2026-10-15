import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const rows = await db.select().from(schema.shopifyShops);
await sql.end();
for (const shop of ['torontofood.myshopify.com', 'janis-store-sx5bpcd3.myshopify.com']) {
  const row = rows.find((r) => r.shop === shop)!;
  const tok = decryptSecret(row.accessTokenEnc!);
  console.log('===', shop, '===');
  const g = (q: string) => fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': tok },
    body: JSON.stringify({ query: q }) }).then((r) => r.json() as Promise<Record<string, unknown>>);
  const dp = await g(`{deliveryProfiles(first:5){nodes{id name default profileLocationGroups{locationGroup{name locations(first:10){nodes{name}}} zones(first:10){name}}}}}`);
  console.log(JSON.stringify((dp as {data?:unknown}).data ?? (dp as {errors?:unknown}).errors, null, 1).slice(0, 3500));
}
