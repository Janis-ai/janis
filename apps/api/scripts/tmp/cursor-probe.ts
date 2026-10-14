import { createDb } from '../../src/db/client.js';
import { agentSecrets, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const secrets: Record<string, string> = {};
for (const s of await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!))) secrets[s.name] = decryptSecret(s.valueEnc);
const q = `query($q:String!,$after:String){productsCount(query:$q){count} products(first:12,query:$q,after:$after){pageInfo{hasNextPage endCursor} nodes{title variants(first:1){nodes{id availableForSale price}}}}}`;
// decode the cursor the model used
const cur = 'eyJsYXN0X3ZhbHVlIjoiNzA0OTgyNjY3MTczOSIsImlkIjo3MDQ5ODI2NjcxNzM5fQ==';
console.log('decoded cursor:', Buffer.from(cur, 'base64').toString());
for (const [label, after] of [['page1', undefined], ['page2-with-cursor', cur]] as const) {
  const res = await fetch(`https://${secrets.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': secrets.SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { q: 'status:active published_status:published', after } }),
  });
  const j = await res.json();
  if (j.errors) { console.log(label, 'ERRORS:', JSON.stringify(j.errors).slice(0, 300)); continue; }
  const p = j.data.products;
  console.log(label, `→ ${p.nodes.length} nodes, hasNext=${p.pageInfo.hasNextPage}:`);
  for (const n of p.nodes) console.log('   ', n.title, '| avail:', n.variants.nodes[0]?.availableForSale, '| price:', n.variants.nodes[0]?.price);
}
process.exit(0);
