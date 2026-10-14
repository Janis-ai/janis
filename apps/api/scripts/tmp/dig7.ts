import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const token = decryptSecret(shop!.accessTokenEnc!);
const gql = async (query: string, variables: Record<string, unknown>) => {
  const res = await fetch(`https://${shop!.shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
};
// who is product 12677402607726?
const n = await gql('query($id:ID!){node(id:$id){... on Product{title}}}', { id: 'gid://shopify/Product/12677402607726' });
console.log('cursor-id product:', JSON.stringify(n.data?.node ?? n.errors));
// and what does an invalid cursor do? (simulate a fabricated one)
const bad = await gql('query($q:String!,$after:String){products(first:12,query:$q,after:$after){nodes{title}}}', { q: ' status:active published_status:published', after: 'eyJmYWtlIjoiY3Vyc29yIn0=' });
console.log('invalid cursor →', JSON.stringify(bad).slice(0, 300));
process.exit(0);
