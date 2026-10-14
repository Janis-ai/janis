import { createDb } from '../../src/db/client.js';
import { agentSecrets, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);
// latest draft order id
const r = await fetch(`https://${secrets.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': secrets.SHOPIFY_TOKEN },
  body: JSON.stringify({ query: '{draftOrders(first:3,reverse:true){nodes{id name}}}' }),
});
const d = await r.json();
const id = d.data.draftOrders.nodes[0].id;
console.log('latest draft:', id);
const r2 = await fetch(`https://${secrets.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-shopify-access-token': secrets.SHOPIFY_TOKEN },
  body: JSON.stringify({
    query: 'mutation($id:ID!){draftOrderInvoiceSend(draftOrderId:$id){draftOrder{id name} userErrors{field message}}}',
    variables: { id },
  }),
});
console.log(JSON.stringify(await r2.json()));
process.exit(0);
