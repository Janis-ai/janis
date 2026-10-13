// Probe the dev-store token's real access — does read_orders actually
// work despite the partial scope string from token exchange? DATABASE_URL
// (prod read) needed to decrypt the stored offline token.
import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';

const shop = process.argv[2] ?? 'janis-store-sx5bpcd3.myshopify.com';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop));
if (!row?.accessTokenEnc) throw new Error(`no token for ${shop}`);
const token = decryptSecret(row.accessTokenEnc);

const gql = async (query: string) => {
  const res = await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 600) };
};

console.log('stored scopes:', row.scopes);
console.log('shop query:', await gql('{ shop { name myshopifyDomain } }'));
console.log('orders query:', await gql('{ orders(first: 1) { nodes { id name } } }'));
console.log(
  'orders+PII query:',
  await gql(
    '{ orders(first: 1) { nodes { id name customer { email firstName } shippingAddress { phone } } } }',
  ),
);
console.log(
  'customers+PII query:',
  await gql('{ customers(first: 1) { nodes { id email displayName } } }'),
);
process.exit(0);
