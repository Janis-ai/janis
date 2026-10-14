import { createDb } from '../../src/db/client.js';
import { agentSecrets, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);
const q = `query { products(first: 20, query:"") { nodes { title handle status totalInventory
  variants(first:10){nodes{id title price availableForSale inventoryQuantity inventoryPolicy inventoryItem{tracked}}}
} } }`;
const r = await fetch(`https://${row!.shop}/admin/api/2025-10/graphql.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': secrets.SHOPIFY_TOKEN! },
  body: JSON.stringify({ query: q }),
});
const j = await r.json();
if (j.errors) { console.log(JSON.stringify(j.errors).slice(0, 800)); process.exit(1); }
for (const p of j.data.products.nodes) {
  console.log(`${p.title} | status=${p.status} totalInv=${p.totalInventory} pub=${p.publishedOnCurrentPublication}`);
  for (const v of p.variants.nodes)
    console.log(`   v ${v.title} price=${v.price} avail=${v.availableForSale} qty=${v.inventoryQuantity} policy=${v.inventoryPolicy} tracked=${v.inventoryItem?.tracked}`);
}
process.exit(0);
