import { createDb } from '../../src/db/client.js';
import { agentSecrets, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);
const q = 'query($q:String!,$after:String){productsCount(query:$q){count} products(first:12,query:$q,after:$after){pageInfo{hasNextPage endCursor} nodes{id title handle status vendor productType tags totalInventory description(truncateAt:120) onlineStoreUrl featuredImage{url} images(first:3){nodes{url}} collections(first:3){nodes{title}} category{fullName} seo{title description} priceRangeV2{minVariantPrice{amount currencyCode} maxVariantPrice{amount currencyCode}} compareAtPriceRange{minVariantCompareAtPrice{amount currencyCode} maxVariantCompareAtPrice{amount currencyCode}} variants(first:10){nodes{id title sku price compareAtPrice availableForSale inventoryQuantity inventoryPolicy selectedOptions{name value} inventoryItem{tracked requiresShipping measurement{weight{value unit}}}}} metafields(first:10){nodes{namespace key value type}}}}}';
const r = await fetch(`https://${row!.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': secrets.SHOPIFY_TOKEN! },
  body: JSON.stringify({ query: q, variables: { q: ' status:active published_status:published', after: null } }),
});
const j = await r.json();
if (j.errors) { console.log('ERRORS:', JSON.stringify(j.errors).slice(0, 1500)); process.exit(1); }
const n = j.data.products.nodes;
console.log('count:', j.data.productsCount.count, 'nodes:', n.length, 'hasNext:', j.data.products.pageInfo.hasNextPage);
console.log('sample:', JSON.stringify(n[0]).slice(0, 1200));
console.log('bytes:', JSON.stringify(j).length);
process.exit(0);
