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
const r = await fetch('https://torontofood.myshopify.com/admin/api/2026-10/shop.json', {
  headers: { 'x-shopify-access-token': tok } });
const j = await r.json() as { shop?: Record<string, unknown> };
const shop = j.shop ?? {};
for (const k of ['checkout_api_supported','plan_name','setup_required','password_enabled','enabled_presentment_currencies','checkout_api_url'])
  console.log(k, '=', JSON.stringify(shop[k]));
// product detail via REST — sales channels + inventory
const pr = await fetch('https://torontofood.myshopify.com/admin/api/2026-10/products.json?handle=the-videographer-snowboard', {
  headers: { 'x-shopify-access-token': tok } });
const pj = await pr.json() as { products?: { title: string; published_scope: string; status: string; variants: { id: number; inventory_quantity: number; inventory_management: string; inventory_policy: string }[] }[] };
for (const p of pj.products ?? []) {
  console.log(p.title, '| scope:', p.published_scope, '| status:', p.status);
  for (const v of p.variants) console.log('  v', v.id, '| qty:', v.inventory_quantity, '| mgmt:', v.inventory_management, '| policy:', v.inventory_policy);
}
