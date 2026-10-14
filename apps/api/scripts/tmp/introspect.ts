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
for (const name of ['customerUpdate', 'discountCodeBasicCreate', 'returnRequest', 'returnCreate']) {
  const r = await q(`{__type(name:"Mutation"){fields{name args{name type{name kind ofType{name kind ofType{name}}}}}}}`);
  const f = r.data.__type.fields.filter((x: { name: string }) => x.name === name);
  for (const field of f) {
    const args = field.args.map((a: { name: string; type: { name?: string; kind: string; ofType?: { name?: string; kind?: string; ofType?: { name?: string } } } }) => {
      const t = a.type.name ?? a.type.ofType?.name ?? a.type.ofType?.ofType?.name ?? a.type.kind;
      return `${a.name}:${t}`;
    });
    console.log(name, '(', args.join(', '), ')');
  }
}
// fulfillmentLineItems on Fulfillment?
const r2 = await q(`{__type(name:"Fulfillment"){fields{name}}}`);
console.log('Fulfillment fields:', r2.data.__type.fields.map((f:{name:string})=>f.name).filter((n:string)=>/lineItem|status|tracking/i.test(n)).join(','));
process.exit(0);
