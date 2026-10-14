import { createDb } from '../../src/db/client.js';
import { agentSecrets, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);
const q = async (query: string) => {
  const r = await fetch(`https://${secrets.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': secrets.SHOPIFY_TOKEN },
    body: JSON.stringify({ query }),
  });
  return r.json();
};
const inputs = async (t: string) => {
  const r = await q(`{__type(name:"${t}"){inputFields{name type{name kind ofType{name kind ofType{name kind}}}}}}`);
  if (!r.data?.__type) { console.log(t, '→', JSON.stringify(r.errors ?? r.data).slice(0, 200)); return; }
  console.log(t + ':', r.data.__type.inputFields.map((f: { name: string }) => f.name).join(', '));
};
const fields = async (t: string) => {
  const r = await q(`{__type(name:"${t}"){fields{name}}}`);
  console.log(t + ':', (r.data?.__type?.fields ?? []).map((f: { name: string }) => f.name).join(', '));
};
await inputs('ReturnRequestInput');
await inputs('ReturnRequestLineItemInput');
await inputs('CustomerInput');
await inputs('DiscountCodeBasicInput');
await fields('FulfillmentLineItem');
process.exit(0);
