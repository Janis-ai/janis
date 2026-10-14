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
const tool = tools.find((t) => t.name === 'shopify_search_products')!;
const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);
const raw = await callTool(tool, { query: 'status:active' }, secrets);
console.log('result bytes:', raw.length);
const parsed = JSON.parse(raw);
console.log('nodes:', parsed.data.products.nodes.length, 'count:', parsed.data.productsCount.count);
const w = widgetFromToolResult(tool.widget!, raw, secrets);
if (w?.type === 'cards') {
  console.log('cards:', w.items.length);
  for (const it of w.items.slice(0, 5)) console.log(` - ${it.title} | ${it.price} | stock=${it.stock ?? '-'} | img=${!!it.image}`);
} else console.log('NO WIDGET', JSON.stringify(w)?.slice(0, 200));
process.exit(0);
