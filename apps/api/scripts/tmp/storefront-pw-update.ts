import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { encryptSecret, decryptSecret } from '../../src/lib/secrets.js';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const pw = process.env.SF_PW!;
await db.update(schema.agentSecrets)
  .set({ valueEnc: encryptSecret(pw), updatedAt: new Date() })
  .where(and(
    eq(schema.agentSecrets.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'),
    eq(schema.agentSecrets.name, 'SHOPIFY_STOREFRONT_PASSWORD')));
await sql.end();
console.log('secret updated');

// End-to-end: password gate → digest → product.js → cart add
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
const cookies = res.headers.getSetCookie();
const digest = cookies.find((c) => c.startsWith('storefront_digest'));
console.log('password gate →', res.status, '| digest:', digest ? 'granted' : 'DENIED');
if (!digest) process.exit(1);
const cookie = digest.split(';')[0];
const pj = await fetch('https://torontofood.myshopify.com/products/snowboard.js', {
  headers: { accept: 'application/json', cookie }, redirect: 'manual' });
console.log('product.js →', pj.status);
if (pj.ok) {
  const p = await pj.json() as { title?: string; variants?: { id: number; available: boolean }[] };
  const v = p.variants?.find((x) => x.available) ?? p.variants?.[0];
  console.log('product:', p.title, '| variant', v?.id, 'avail:', v?.available);
  if (v) {
    const cart = await fetch('https://torontofood.myshopify.com/cart/add.js', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ items: [{ id: v.id, quantity: 1 }] }),
    });
    console.log('cart add →', cart.status, (await cart.text()).slice(0, 150));
  }
}
