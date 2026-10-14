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
const pw = decryptSecret(s.valueEnc);
console.log('pw length', pw.length, 'first2:', pw.slice(0,2));
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
console.log('status', res.status, 'location:', res.headers.get('location'));
for (const c of res.headers.getSetCookie()) console.log('set-cookie:', c.split(';')[0].split('=')[0]);
const body = await res.text();
console.log('body has password form:', body.includes('storefront_password'), '| len:', body.length);
