import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const [s] = await db.select().from(schema.shopifyShops).where(eq(schema.shopifyShops.shop, 'torontofood.myshopify.com'));
await sql.end();
console.log('granted scopes:', s.grantedScopes);
const tok = decryptSecret(s.accessTokenEnc!);
const get = async (path: string) => {
  const r = await fetch(`https://torontofood.myshopify.com/admin/api/2026-10${path}`, { headers: { 'x-shopify-access-token': tok } });
  return { status: r.status, body: await r.text() };
};
const locs = await get('/locations.json');
console.log('locations →', locs.status);
try {
  const lj = JSON.parse(locs.body) as { locations?: { id: number; name: string; active: boolean; fulfills_online_orders?: boolean }[] };
  for (const l of lj.locations ?? []) console.log(' ', l.id, l.name, '| active:', l.active, '| fulfills online:', l.fulfills_online_orders);
} catch { console.log(locs.body.slice(0, 300)); }
const vr = await get('/variants/67743871205698.json');
const iid = (JSON.parse(vr.body) as { variant?: { inventory_item_id?: number } }).variant?.inventory_item_id;
const lv = await get(`/inventory_levels.json?inventory_item_ids=${iid}`);
console.log('levels →', lv.status);
try {
  const lj = JSON.parse(lv.body) as { inventory_levels?: { location_id: number; available: number }[] };
  for (const x of lj.inventory_levels ?? []) console.log('  loc', x.location_id, '→ available:', x.available);
} catch { console.log(lv.body.slice(0, 300)); }
