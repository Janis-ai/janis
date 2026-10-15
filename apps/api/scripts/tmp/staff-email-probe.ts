import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';

const shop = 'blamp-vzfzgclz.myshopify.com';
const sub = '115101761752';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop));
const token = decryptSecret(row!.accessTokenEnc!);
console.log('stored scopes:', row!.scopes);

const gql = async (query: string) => {
  const res = await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query }),
  });
  return (await res.text()).slice(0, 900);
};

console.log('staffMember full:', await gql(
  `{ staffMember(id: "gid://shopify/StaffMember/${sub}") { id name firstName lastName email } }`,
));
console.log('---');
console.log('staffMember as User gid:', await gql(
  `{ staffMember(id: "gid://shopify/User/${sub}") { id name firstName lastName email } }`,
));
process.exit(0);
