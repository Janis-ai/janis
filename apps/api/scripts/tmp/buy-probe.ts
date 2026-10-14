import { createDb } from '../../src/db/client.js';
import { agentSecrets, agents, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
import { callTool, type ToolDef } from '../../src/lib/toolExec.js';
import { widgetFromToolResult } from '../../src/lib/widgets.js';

const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const [a] = await db.select({ config: agents.config }).from(agents).where(eq(agents.id, row!.agentId!));
const tools = ((a?.config as { tools?: ToolDef[] })?.tools ?? []) as ToolDef[];
const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);

// a catalog variant — the in-stock wax
const search = tools.find((t) => t.name === 'shopify_search_products')!;
const res = JSON.parse(await callTool(search, { query: 'status:active title:*wax*' }, secrets));
const variant = res.data.products.nodes[0].variants.nodes[0];
console.log('variant:', variant.id, 'avail:', variant.availableForSale);

const draft = tools.find((t) => t.name === 'shopify_create_draft_order')!;
const dRes = await callTool(draft, {
  draft_order: { lineItems: [{ variantId: variant.id, quantity: 1 }], email: 'devin-probe@janis.ai' },
}, secrets);
const d = JSON.parse(dRes).data.draftOrderCreate;
console.log('draft:', d.draftOrder?.name, d.draftOrder?.invoiceUrl?.slice(0, 60), 'errs:', d.userErrors?.length);
const w = widgetFromToolResult(draft.widget!, dRes, secrets);
if (w?.type === 'cards') console.log('card:', JSON.stringify(w.items[0]));

const send = tools.find((t) => t.name === 'shopify_send_invoice')!;
const sRes = await callTool(send, { draft_order_id: d.draftOrder.id }, secrets);
const sd = JSON.parse(sRes).data.draftOrderInvoiceSend;
console.log('invoice sent:', sd.draftOrder?.id ? 'yes' : 'no', 'errs:', JSON.stringify(sd.userErrors));

// cleanup — delete the draft
const del = await callTool(
  { name: 'x', method: 'POST', url: 'https://{{secrets.SHOPIFY_SHOP}}/admin/api/2026-10/graphql.json',
    headers: { 'X-Shopify-Access-Token': '{{secrets.SHOPIFY_TOKEN}}' },
    bodyTemplate: '{"query":"mutation($id:ID!){draftOrderDelete(input:{id:$id}){deletedId userErrors{message}}}","variables":{"id":"${id:text}"}}',
    params: { id: 'gid' } },
  { id: d.draftOrder.id }, secrets);
console.log('deleted:', del.includes('deletedId'));
process.exit(0);
