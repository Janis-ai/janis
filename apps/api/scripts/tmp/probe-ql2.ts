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
const f = await gql(`{__schema{queryType{fields(includeDeprecated:true){name type{name kind ofType{name kind}}}}}}`);
const qq = (f as any).data.__schema.queryType.fields.find((x: any) => x.name === 'shopifyqlQuery');
console.log('field:', JSON.stringify(qq));
const tn = qq?.type?.name ?? qq?.type?.ofType?.name;
const t = await gql(`{__type(name:"${tn}"){name kind possibleTypes{name fields{name type{name kind ofType{name kind ofType{name}}}}}}}`);
console.log('type:', JSON.stringify(t.data?.__type).slice(0, 2500));
process.exit(0);
