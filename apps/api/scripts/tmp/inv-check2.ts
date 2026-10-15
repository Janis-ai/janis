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
  return r.json();
};
const j = await gql(`{products(first:3,query:"handle:the-videographer-snowboard"){nodes{title variants(first:3){nodes{sku inventoryQuantity inventoryItem{tracked inventoryLevels(first:5){nodes{quantities(names:["available","committed","on_hand"]){name quantity} location{name}}}}}}}}}`) as {
  data?: { products?: { nodes: { title: string; variants: { nodes: { sku?: string; inventoryQuantity: number; inventoryItem?: { tracked: boolean; inventoryLevels?: { nodes?: { quantities: { name: string; quantity: number }[]; location: { name: string } }[] } } }[] } }[] } }; errors?: {message:string}[] };
console.log(JSON.stringify(j.data?.products?.nodes ?? j.errors, null, 1).slice(0, 3000));
