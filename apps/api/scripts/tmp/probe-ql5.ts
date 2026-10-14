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
const t = await gql(`{__type(name:"ShopifyqlTableData"){fields{name type{kind name ofType{kind name ofType{name}}}}}}`);
const cols = (t.data?.__type?.fields ?? []).find((f: any) => f.name === 'columns');
const cn = cols?.type?.ofType?.name ?? cols?.type?.ofType?.ofType?.name;
console.log('column type:', cn);
const c = await gql(`{__type(name:"${cn}"){name fields{name type{name kind ofType{name}}}}}`);
console.log('column fields:', JSON.stringify((c.data?.__type?.fields ?? []).map((f: any) => f.name)));
const pe = await gql(`{__type(name:"ShopifyqlParseError"){fields{name}}}`);
console.log('parseError fields:', JSON.stringify(pe.data));
process.exit(0);
