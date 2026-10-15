import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });
const [s] = await db.select().from(schema.shopifyShops).where(eq(schema.shopifyShops.shop, 'torontofood.myshopify.com'));
await sql.end();
const tok = decryptSecret(s.accessTokenEnc!);
const gql = async (query: string) => {
  const r = await fetch('https://torontofood.myshopify.com/admin/api/2026-10/graphql.json', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': tok },
    body: JSON.stringify({ query }) });
  return r.json() as Promise<Record<string, unknown>>;
};
console.log('MarketCatalog fields:', JSON.stringify((await gql(`{__type(name:"MarketCatalog"){fields{name type{name kind ofType{name kind}}}}}`.replace('kind ofType','kind ofType'))).data, null, 1).slice(0, 1800));
const c = await gql(`{catalog(id:"gid://shopify/MarketCatalog/176171942210"){id title status operations{__typename status processedRowCount}}}`);
console.log('ops:', JSON.stringify(c, null, 1).slice(0, 1200));
