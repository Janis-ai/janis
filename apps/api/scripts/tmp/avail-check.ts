const pw = process.env.SF_PW!;
const res = await fetch('https://torontofood.myshopify.com/password', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: pw }),
  redirect: 'manual',
});
const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const handles = ['the-videographer-snowboard','the-complete-snowboard','the-collection-snowboard-liquid','selling-plans-ski-wax','gift-card','the-inventory-not-tracked-snowboard'];
for (const h of handles) {
  const pj = await fetch(`https://torontofood.myshopify.com/products/${h}.js`, {
    headers: { accept: 'application/json', cookie, 'user-agent': 'Mozilla/5.0' }, redirect: 'manual' });
  if (!pj.ok) { console.log(h, '→', pj.status); continue; }
  const p = await pj.json() as { title: string; available: boolean; variants: { id: number; available: boolean }[] };
  console.log(p.title, '| avail:', p.available, '| variants:', p.variants.map(v=>`${v.id}:${v.available}`).join(' '));
}
// admin inventory truth
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
const gql = await fetch('https://torontofood.myshopify.com/admin/api/2026-10/graphql.json', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': tok },
  body: JSON.stringify({ query: '{products(first:20){nodes{title totalInventory variants(first:3){nodes{inventoryQuantity inventoryPolicy availableForSale}}}}}' }),
});
const j = await gql.json() as { data?: { products?: { nodes: { title: string; totalInventory: number; variants: { nodes: { inventoryQuantity: number; inventoryPolicy: string; availableForSale: boolean }[] } }[] } }, errors?: {message:string}[] };
if (j.errors) console.log('gql errors:', JSON.stringify(j.errors).slice(0,300));
for (const p of j.data?.products?.nodes ?? [])
  console.log(`admin: ${p.title} | total:${p.totalInventory} | v:`, p.variants.nodes.map(v=>`q${v.inventoryQuantity}/${v.inventoryPolicy}/afs:${v.availableForSale}`).join(' '));
