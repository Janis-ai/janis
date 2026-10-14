import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';
const shop = 'janis-store-sx5bpcd3.myshopify.com';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop));
const token = decryptSecret(row!.accessTokenEnc);
const res = await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
  body: JSON.stringify({
    query: '{collectionsCount{count} collections(first:25){nodes{id title handle description(truncateAt:120) image{url} productsCount{count}}}}',
    variables: { _pad: null },
  }),
});
const j = await res.json();
console.log(JSON.stringify(j).slice(0, 800));
process.exit(0);
