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
const get = async (path: string) => {
  const r = await fetch(`https://torontofood.myshopify.com/admin/api/2026-10${path}`, { headers: { 'x-shopify-access-token': tok } });
  return { status: r.status, body: await r.text() };
};
const locs = await get('/locations.json');
console.log('locations →', locs.status, locs.body.slice(0, 600));
const lv = await get('/inventory_levels.json?inventory_item_ids=71198843568450'); // guess id — will likely need real item id
console.log('inv levels →', lv.status, lv.body.slice(0, 300));
// real inventory item id from variant
const vr = await get('/variants/67743871205698.json');
const vj = JSON.parse(vr.body) as { variant?: { inventory_item_id?: number } };
const iid = vj.variant?.inventory_item_id;
console.log('inventory_item_id:', iid);
if (iid) {
  const lv2 = await get(`/inventory_levels.json?inventory_item_ids=${iid}`);
  console.log('levels →', lv2.status, lv2.body.slice(0, 800));
}
