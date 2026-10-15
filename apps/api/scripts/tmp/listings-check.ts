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
const all = await get('/product_listings.json?limit=250');
console.log('listings →', all.status);
try {
  const j = JSON.parse(all.body) as { product_listings?: { title: string; handle: string; available: boolean; variants?: { available: boolean }[] }[] };
  console.log('count:', j.product_listings?.length);
  for (const p of j.product_listings ?? []) console.log(' ', p.handle, '| available:', p.available, '| variants:', p.variants?.map((v) => v.available).join(','));
} catch { console.log(all.body.slice(0, 400)); }
