import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops);
const res = await fetch(`https://${row!.shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': decryptSecret(row!.accessTokenEnc!) },
  body: JSON.stringify({ query: '{shop{shopPolicies{type title body}}}' }),
});
console.log(JSON.stringify(await res.json()).slice(0, 1500));
process.exit(0);
