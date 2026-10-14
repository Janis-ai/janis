import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const [s] = await db.select().from(schema.agentSecrets).where(and(
  eq(schema.agentSecrets.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'),
  eq(schema.agentSecrets.name, 'SHOPIFY_STOREFRONT_PASSWORD')));
await sql.end();
if (!s) { console.log('no password secret'); process.exit(0); }
const pw = decryptSecret(s.valueEnc);
// Try the password gate
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
const cookie = res.headers.get('set-cookie')?.split(';')[0];
console.log('password POST →', res.status, 'cookie:', cookie ? 'granted' : 'none');
if (cookie?.includes('storefront_digest')) {
  const cart = await fetch('https://torontofood.myshopify.com/cart/add.js', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ items: [{ id: 1, quantity: 1 }] }),
  });
  console.log('cart add →', cart.status, (await cart.text()).slice(0, 200));
}
