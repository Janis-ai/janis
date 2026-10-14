import { createDb } from '../../src/db/client.js';
import { loadSecretsMap } from '../../src/lib/secrets.js';
const db = await createDb();
const secrets = await loadSecretsMap(db, 'd408d7b5-fdad-49a4-a34d-11fa16e88135');
const q = `query { products(first:20, query:"status:active published_status:published") { nodes { title variants(first:10){nodes{title availableForSale sellableOnlineQuantity inventoryQuantity}} } } }`;
const r = await fetch(`https://${secrets.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': secrets.SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: q }),
});
const j = await r.json();
if (j.errors) { console.log(JSON.stringify(j.errors).slice(0,500)); process.exit(0); }
for (const p of j.data.products.nodes) {
  for (const v of p.variants.nodes)
    console.log(`${p.title} | ${v.title} | avail:${v.availableForSale} sellableOnline:${v.sellableOnlineQuantity} invQty:${v.inventoryQuantity}`);
}
process.exit(0);
