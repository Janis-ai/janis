import { createDb } from '../../src/db/client.js';
import { loadSecretsMap } from '../../src/lib/secrets.js';
const db = await createDb();
const secrets = await loadSecretsMap(db, 'd408d7b5-fdad-49a4-a34d-11fa16e88135');
const q = `query { products(first:20, query:"status:active published_status:published") { nodes { title status totalInventory options{name} sellingPlanGroups(first:3){nodes{name}} variants(first:10){nodes{title availableForSale inventoryQuantity price}} } } }`;
const r = await fetch(`https://${secrets.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': secrets.SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: q }),
});
const j = await r.json();
for (const p of j.data.products.nodes) {
  const vs = p.variants.nodes;
  const anyAvail = vs.some(v => v.availableForSale);
  console.log(`${anyAvail ? 'AVAIL' : 'OOS  '} inv:${String(p.totalInventory).padStart(3)} v:${vs.length} plans:[${p.sellingPlanGroups.nodes.map(g=>g.name).join(',')}] ${p.title}`);
  for (const v of vs) console.log(`      ${v.availableForSale ? '  ok ' : ' OOS '} $${v.price} qty:${v.inventoryQuantity} ${v.title}`);
}
process.exit(0);
