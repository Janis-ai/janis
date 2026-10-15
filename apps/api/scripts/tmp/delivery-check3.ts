import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
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
    body: JSON.stringify({ query: q }) }).then((r) => r.json() as Promise<any>);
  const dp = await g(`{deliveryProfiles(first:5){nodes{id name default profileLocationGroups{locationGroup{locations(first:10){nodes{name}}} locationGroupZones(first:10){nodes{zone{name} methodDefinitions(first:5){nodes{active}}}}}}}}`);
  if (!dp.data) { console.log(JSON.stringify(dp.errors, null, 1).slice(0, 1200)); continue; }
  for (const p of dp.data.deliveryProfiles.nodes) {
    console.log(' profile:', p.name, p.default ? '(default)' : '');
    for (const plg of p.profileLocationGroups) {
      console.log('   locations:', plg.locationGroup.locations.nodes.map((l: any) => l.name).join(', ') || '(none)');
      for (const z of plg.locationGroupZones.nodes)
        console.log('   zone:', z.zone.name, '| active methods:', z.methodDefinitions.nodes.filter((m: any) => m.active).length);
    }
  }
}
