// Verify the paged search tool against the live store using the agent's
// STORED def — first page (after omitted), then a second page via the
// returned endCursor. DATABASE_URL + JANIS_SECRETS_KEY from prod env.
import { createDb } from '../../src/db/client.js';
import { agentSecrets, agents, shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../../src/lib/secrets.js';
import { callTool, type ToolDef } from '../../src/lib/toolExec.js';

const db = await createDb();
const [row] = await db
  .select()
  .from(shopifyShops)
  .where(eq(shopifyShops.shop, 'janis-store-sx5bpcd3.myshopify.com'));
const [a] = await db.select({ config: agents.config }).from(agents).where(eq(agents.id, row!.agentId!));
const tools = ((a?.config as { tools?: ToolDef[] })?.tools ?? []) as ToolDef[];
const tool = tools.find((t) => t.name === 'shopify_search_products')!;
console.log('stored bodyTemplate has $after:', tool.bodyTemplate!.includes('$after'));

const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, row!.agentId!));
const secrets: Record<string, string> = {};
for (const s of secretRows) secrets[s.name] = decryptSecret(s.valueEnc);

const page1 = JSON.parse(await callTool(tool, { query: 'status:active' }, secrets));
const p1 = page1.data.products;
console.log(`page1: count=${page1.data.productsCount.count} nodes=${p1.nodes.length} hasNextPage=${p1.pageInfo.hasNextPage} endCursor=${p1.pageInfo.endCursor}`);
console.log('first 3:', p1.nodes.slice(0, 3).map((n: { title: string }) => n.title).join(' | '));
console.log('variantId sample:', p1.nodes[0]?.variants?.nodes?.[0]?.id);

const page2 = JSON.parse(
  await callTool(tool, { query: 'status:active', after: p1.pageInfo.endCursor }, secrets),
);
const p2 = page2.data.products;
console.log(`page2: nodes=${p2.nodes.length} hasNextPage=${p2.pageInfo.hasNextPage}`);
process.exit(0);
