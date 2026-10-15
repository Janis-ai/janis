import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const rows = await db.select().from(schema.shopifyShops);
await sql.end();
for (const shop of ['janis-store-sx5bpcd3.myshopify.com', 'janis-inc.myshopify.com', 'torontofood.myshopify.com']) {
  const row = rows.find((r) => r.shop === shop)!;
  const tok = decryptSecret(row.accessTokenEnc!);
  console.log('===', shop, '===');
  const pj = await fetch(`https://${shop}/products.json?limit=5`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  const j = await pj.json().catch(() => ({})) as { products?: { handle: string; variants: { available: boolean }[] }[] };
  for (const p of j.products ?? []) console.log('  sf', p.handle, p.variants.map((v) => v.available).join(','));
  const g = (q: string) => fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': tok },
    body: JSON.stringify({ query: q }) }).then((r) => r.json() as Promise<Record<string, unknown>>);
  const mk = await g(`{markets(first:10){nodes{name primary enabled}}}`);
  const mkErr = (mk as { errors?: {message:string}[] }).errors?.[0]?.message;
  const mkData = (mk as { data?: { markets?: { nodes?: {name:string;primary:boolean;enabled:boolean}[] } } }).data;
  console.log('  markets:', mkData?.markets?.nodes?.map((n) => `${n.name}${n.primary?'(P)':''}${n.enabled?'':'(disabled)'}`).join(', ') ?? mkErr);
  const cat = await g(`{catalogs(first:10){nodes{__typename id title status}}}`);
  const catErr = (cat as { errors?: {message:string}[] }).errors?.[0]?.message;
  const catData = (cat as { data?: { catalogs?: { nodes?: {__typename:string;title:string}[] } } }).data;
  console.log('  catalogs:', catData?.catalogs?.nodes?.map((n) => `${n.__typename}:${n.title}`).join(' | ') ?? catErr);
}
