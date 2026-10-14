// Replay the exact page-2 call the model made and dump the nodes.
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

// First, page 1 to get the REAL endCursor
const p1 = JSON.parse(await callTool(tool, { query: '' }, secrets));
console.log('PAGE1 nodes:', p1.data.products.nodes.map((n: any) => n.title).join(' | '));
console.log('PAGE1 hasNext:', p1.data.products.pageInfo.hasNextPage, 'endCursor:', p1.data.products.pageInfo.endCursor);

// Now the model's cursor
const r = JSON.parse(await callTool(tool, { query: '', after: 'eyJwYWdpbmF0ZWluZGV4IjoxMH0' }, secrets));
console.log('\nMODEL-CURSOR nodes:', r.data.products.nodes.map((n: any) => `${n.title}${n.variants?.nodes?.[0]?.availableForSale===false?'(OOS)':''}`).join(' | '));
console.log('hasNext:', r.data.products.pageInfo.hasNextPage, 'endCursor:', r.data.products.pageInfo.endCursor);

// And the REAL endCursor
const r2 = JSON.parse(await callTool(tool, { query: '', after: p1.data.products.pageInfo.endCursor }, secrets));
console.log('\nREAL-PAGE2 nodes:', r2.data.products.nodes.map((n: any) => `${n.title}${n.variants?.nodes?.[0]?.availableForSale===false?'(OOS)':''}`).join(' | '));
console.log('hasNext:', r2.data.products.pageInfo.hasNextPage);
process.exit(0);
