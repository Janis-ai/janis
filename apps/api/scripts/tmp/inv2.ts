import { createDb } from '../../src/db/client.js';
import { agentSecrets, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);
const id = 'gid://shopify/DraftOrder/1292133663003';
const r = await fetch(`https://${secrets.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': secrets.SHOPIFY_TOKEN },
  body: JSON.stringify({
    query: 'mutation($id:ID!){draftOrderInvoiceSend(id:$id){draftOrder{id name} userErrors{field message}}}',
    variables: { id },
  }),
});
console.log(JSON.stringify(await r.json()));
const del = await fetch(`https://${secrets.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': secrets.SHOPIFY_TOKEN },
  body: JSON.stringify({
    query: 'mutation($id:ID!){draftOrderDelete(input:{id:$id}){deletedId userErrors{message}}}',
    variables: { id },
  }),
});
console.log('delete:', JSON.stringify(await del.json()));
process.exit(0);
