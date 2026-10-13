// Refresh the bound agent's stored tool defs to the current catalog —
// the stored shopify_lookup_order still says "verified customer email"
// and carries the stale identity flag; re-run bindShop's merge by name.
import { createDb } from '../../src/db/client.js';
import { agents, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { TOOL_TEMPLATES } from '../../src/lib/toolTemplates.js';

const db = await createDb();
const [shop] = await db
  .select()
  .from(shopifyShops)
  .where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
if (!shop?.agentId) throw new Error('no bound agent');

const tpl = TOOL_TEMPLATES.find((t) => t.id === 'shopify')!;
const [a] = await db.select({ config: agents.config }).from(agents).where(eq(agents.id, shop.agentId));
const cfg = (a?.config ?? {}) as { tools?: Array<{ name?: string }> };
const names = new Set(tpl.tools.map((t) => t.name));
const tools = [
  ...(cfg.tools ?? []).filter((t) => !names.has(t.name ?? '')),
  ...tpl.tools.map((t) => ({ ...t, template: tpl.id })),
];
await db.update(agents).set({ config: { ...cfg, tools } }).where(eq(agents.id, shop.agentId));
console.log(`refreshed ${tools.length} tools on agent ${shop.agentId}`);
process.exit(0);
