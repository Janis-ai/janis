import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';
const shop = 'janis-store-sx5bpcd3.myshopify.com';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop));
const token = decryptSecret(row!.accessTokenEnc);
const res = await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
  body: JSON.stringify({ query: `{__type(name:"ShopifyqlQueryResponse"){fields{name}}}` }),
});
console.log(JSON.stringify((await res.json()).data?.__type?.fields?.map((f: any) => f.name)));
process.exit(0);
