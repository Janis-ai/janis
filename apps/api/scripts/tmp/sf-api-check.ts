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
const admin = await fetch('https://torontofood.myshopify.com/admin/api/2026-10/graphql.json', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': tok },
  body: JSON.stringify({ query: `mutation{storefrontAccessTokenCreate(input:{title:"janis-probe"}){storefrontAccessToken{accessToken}userErrors{message}}}` }) });
const aj = await admin.json() as { data?: { storefrontAccessTokenCreate?: { storefrontAccessToken?: { accessToken?: string }; userErrors?: { message: string }[] } }; errors?: {message:string}[] };
const sfTok = aj.data?.storefrontAccessTokenCreate?.storefrontAccessToken?.accessToken;
console.log('sf token:', sfTok ? 'minted' : JSON.stringify(aj).slice(0, 300));
if (sfTok) {
  const sf = await fetch('https://torontofood.myshopify.com/api/2026-10/graphql.json', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-storefront-access-token': sfTok },
    body: JSON.stringify({ query: `{product(handle:"the-videographer-snowboard"){title availableForSale variants(first:3){nodes{availableForSale quantityAvailable currentlyNotInStock}}}}` }),
  });
  console.log('SF API:', JSON.stringify(await sf.json(), null, 1).slice(0, 1500));
}
