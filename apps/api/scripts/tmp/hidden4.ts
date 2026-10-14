import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const token = decryptSecret(shop!.accessTokenEnc!);
const gql = async (query: string) => {
  const res = await fetch(`https://${shop!.shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return res.json();
};
// 1. status of Hidden
const a = await gql(`{ products(first: 2, query: "title:*Hidden*") { nodes { title status variants(first:2) { nodes { id availableForSale } } } } }`);
console.log('Hidden:', JSON.stringify(a.data));
// 2. does published_status:published drop it?
const b = await gql(`{ products(first: 20, query: "published_status:published") { nodes { title status } } }`);
console.log('published:', (b.data?.products?.nodes ?? []).map((n: any) => `${n.title} [${n.status}]`).join(' | '));
process.exit(0);
