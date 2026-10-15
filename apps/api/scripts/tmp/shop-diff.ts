import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const rows = await db.select().from(schema.shopifyShops);
await sql.end();
const keys = ['name','plan_name','plan_display_name','checkout_api_supported','setup_required','password_enabled','country_code','country_name','currency','enabled_presentment_currencies','myshopify_domain','domain','created_at','transactions_disabled','checkout_api_url','taxes_included','checkout_on'];
for (const shop of ['torontofood.myshopify.com', 'janis-store-sx5bpcd3.myshopify.com', 'janis-inc.myshopify.com']) {
  const row = rows.find((r) => r.shop === shop)!;
  const tok = decryptSecret(row.accessTokenEnc!);
  const r = await fetch(`https://${shop}/admin/api/2026-10/shop.json`, { headers: { 'x-shopify-access-token': tok } });
  const j = await r.json() as { shop?: any };
  const s = j.shop ?? {};
  console.log('===', shop, '===');
  for (const k of keys) if (s[k] !== undefined) console.log(' ', k, '=', JSON.stringify(s[k]));
}
