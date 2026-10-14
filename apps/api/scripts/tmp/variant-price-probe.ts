// Dump ALL variants (price, availableForSale, id) per product so we can see
// why the card price diverges from the charged variant.
import { createDb } from '../../src/db/client.js';
import { agentSecrets, agents, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
import { callTool, type ToolDef } from '../../src/lib/toolExec.js';

const db = await createDb();
const [row] = await db.select().from(shopifyShops).where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const [a] = await db.select({ config: agents.config }).from(agents).where(eq(agents.id, row!.agentId!));
const tools = ((a?.config as { tools?: ToolDef[] })?.tools ?? []) as ToolDef[];
const tool = tools.find((t) => t.name === 'shopify_search_products')!;
const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);

const res = JSON.parse(await callTool(tool, { query: 'status:active' }, secrets));
for (const n of res.data.products.nodes) {
  const vs = (n.variants?.nodes ?? []).map((v: { id: string; availableForSale: boolean; price: string }) =>
    `${v.id.split('/').pop()} avail=${v.availableForSale} $${v.price}`).join('  ||  ');
  console.log(`${n.title}\n   min=${n.priceRangeV2?.minVariantPrice?.amount} max=${n.priceRangeV2?.maxVariantPrice?.amount}\n   ${vs}`);
}
process.exit(0);
