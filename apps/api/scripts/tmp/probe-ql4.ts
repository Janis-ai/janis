import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { decryptSecret } from '../../src/lib/secrets.js';
import { eq } from 'drizzle-orm';
const shop = 'janis-store-sx5bpcd3.myshopify.com';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, shop));
const token = decryptSecret(row!.accessTokenEnc);
const gql = async (q: string) =>
  (await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query: q }),
  })).json();
for (const tn of ['ShopifyqlTableData', 'ShopifyqlTable', 'ShopifyqlRow']) {
  const t = await gql(`{__type(name:"${tn}"){name kind fields{name type{name kind ofType{name kind ofType{name kind}}}}}}`);
  console.log(tn, '=>', JSON.stringify((t.data?.__type?.fields ?? []).map((x: any) => x.name + ':' + (x.type.name ?? x.type.ofType?.name ?? x.type.kind))).slice(0, 900));
}
process.exit(0);
