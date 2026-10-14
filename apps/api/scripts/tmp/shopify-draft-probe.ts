// End-to-end: stored shopify_create_draft_order def → real mutation →
// invoiceUrl → cleanup via draftOrderDelete. DATABASE_URL+SECRETS prod.
import { createDb } from '../../src/db/client.js';
import { agentSecrets, agents, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
import { callTool, type ToolDef } from '../../src/lib/toolExec.js';

const db = await createDb();
const [row] = await db.select().from(shopifyShops);
const [a] = await db.select({ config: agents.config }).from(agents).where(eq(agents.id, row!.agentId!));
const tools = (a!.config as { tools: ToolDef[] }).tools;
const tool = tools.find((t) => t.name === 'shopify_create_draft_order')!;
console.log('stored def approval flag:', tool.approval ?? 'ungated');
const secrets: Record<string, string> = {};
for (const s of await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!)))
  secrets[s.name] = decryptSecret(s.valueEnc);

const out = await callTool(tool, {
  draft_order: JSON.stringify({
    lineItems: [{ variantId: 'gid://shopify/ProductVariant/54223606841627', quantity: 1 }],
    note: 'janis probe — delete me',
  }),
}, secrets);
const res = JSON.parse(out);
const d = res.data?.draftOrderCreate;
console.log('userErrors:', JSON.stringify(d?.userErrors ?? res));
if (d?.draftOrder?.invoiceUrl) {
  console.log('DRAFT OK:', d.draftOrder.name, '→', d.draftOrder.invoiceUrl);
  // cleanup
  const del = await fetch(`https://${secrets.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': secrets.SHOPIFY_TOKEN },
    body: JSON.stringify({ query: `mutation{draftOrderDelete(input:{id:"${d.draftOrder.id}"}){deletedId userErrors{message}}}` }),
  });
  console.log('cleanup:', JSON.stringify((await del.json()).data?.draftOrderDelete));
}
process.exit(0);
