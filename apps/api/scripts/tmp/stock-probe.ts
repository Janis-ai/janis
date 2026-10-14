import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops);
const tok = decryptSecret(row!.accessTokenEnc!);
const res = await fetch(`https://${row!.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': tok, 'content-type': 'application/json' },
  body: JSON.stringify({
    query:
      'query{products(first:20,query:"status:active"){nodes{title variants(first:1){nodes{id availableForSale inventoryQuantity tracked}}}}}',
  }),
});
const d = (await res.json()) as { data?: { products?: { nodes?: { title: string; variants: { nodes: { availableForSale: boolean | null; inventoryQuantity: number | null; tracked: boolean }[] } }[] } } };
for (const p of d.data?.products?.nodes ?? []) {
  const v = p.variants.nodes[0];
  console.log(`${String(v?.availableForSale).padEnd(6)} tracked=${String(v?.tracked).padEnd(6)} qty=${String(v?.inventoryQuantity).padEnd(5)} ${p.title}`);
}
process.exit(0);
