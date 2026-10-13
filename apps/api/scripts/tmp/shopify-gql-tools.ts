// Live-fire the GraphQL shopify_* tool defs against the bound dev store:
// pulls SHOPIFY_SHOP/SHOPIFY_TOKEN out of the bound agent's secrets and runs
// the read tools through the real callTool pipeline (template → secrets →
// fetch). DATABASE_URL + JANIS_SECRETS_KEY must be set (prod values).
import { createDb } from '../../src/db/client.js';
import { agentSecrets, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
import { callTool, type ToolDef } from '../../src/lib/toolExec.js';
import { TOOL_TEMPLATES } from '../../src/lib/toolTemplates.js';
import { widgetFromToolResult } from '../../src/lib/widgets.js';

const db = await createDb();
const [row] = await db
  .select()
  .from(shopifyShops)
  .where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
if (!row?.agentId) throw new Error('no bound shop row');
const secretRows = await db
  .select()
  .from(agentSecrets)
  .where(eq(agentSecrets.agentId, row.agentId));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);
if (!secrets.SHOPIFY_TOKEN) throw new Error('no SHOPIFY_TOKEN mirrored');

const tools = new Map(
  (TOOL_TEMPLATES.find((t) => t.id === 'shopify')!.tools as ToolDef[]).map((t) => [t.name, t]),
);

async function run(name: string, args: Record<string, unknown>) {
  const tool = tools.get(name)!;
  const out = await callTool(tool, args, secrets);
  console.log(`\n=== ${name} ===\n${out.slice(0, 800)}`);
  return out;
}

const products = await run('shopify_search_products', { query: 'snowboard' });
const w = tools.get('shopify_search_products')!.widget;
if (w) {
  const parsed = JSON.parse(products);
  const widget = widgetFromToolResult(w, JSON.stringify(parsed.data ? parsed : parsed), secrets);
  console.log('\n=== widget render ===');
  console.log(JSON.stringify(widget, null, 1)?.slice(0, 1200));
}

await run('shopify_customer_orders', { email: 'test@example.com' });
await run('shopify_lookup_order', { order_number: '#1001', email: 'test@example.com' });
process.exit(0);
