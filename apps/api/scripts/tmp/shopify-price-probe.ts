// Sanity: the NEW search query shape against the live store — variant
// scalar price, plus the :money map path producing the card price.
import { createDb } from '../../src/db/client.js';
import { agentSecrets, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';

const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);

const q = `query($q:String!){productsCount(query:$q){count} products(first:12,query:$q){pageInfo{hasNextPage endCursor} nodes{title priceRangeV2{minVariantPrice{amount currencyCode}} variants(first:1){nodes{id availableForSale price}}}}}`;
const res = await fetch(`https://${secrets.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': secrets.SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: q, variables: { q: 'status:active published_status:published' } }),
});
const j = await res.json();
if (j.errors) { console.log('ERRORS:', JSON.stringify(j.errors).slice(0, 500)); process.exit(1); }
for (const n of j.data.products.nodes.slice(0, 5)) {
  const v = n.variants.nodes[0];
  console.log(`${n.title} | variant.price=${v?.price} | min=${n.priceRangeV2.minVariantPrice.amount} | avail=${v?.availableForSale}`);
}
process.exit(0);
