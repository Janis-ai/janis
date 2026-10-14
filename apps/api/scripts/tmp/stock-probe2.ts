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
      'query{products(first:20,query:"status:active"){nodes{title variants(first:1){nodes{availableForSale inventoryItem{tracked measurement{weight{value}}}}}}}}',
  }),
});
const d = await res.json();
console.log(JSON.stringify(d, null, 1).slice(0, 4000));
process.exit(0);
