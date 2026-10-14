import { createDb } from '../../src/db/client.js';
import { agents } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { toolsFor, callTool } from '../../src/lib/toolExec.js';
import { widgetFromToolResult } from '../../src/lib/widgets.js';
import { loadSecretsMap } from '../../src/lib/secrets.js';

const db = await createDb();
const [agent] = await db.select().from(agents).where(eq(agents.id, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
const tool = toolsFor(agent).find((t) => t.name === 'shopify_search_products')!;
const secrets = await loadSecretsMap(db, agent.id);
const res = await callTool(tool, { query: 'status:active' }, secrets);
console.log('result bytes:', res.length, '| truncated:', res.includes('truncat'));
const d = JSON.parse(res);
console.log('count:', d.data.productsCount?.count, '| nodes:', d.data.products.nodes.length);
const w = widgetFromToolResult(tool.widget!, res, secrets);
console.log('cards:', w?.type === 'cards' ? w.items.length : 'NULL', '| first price:', w?.type === 'cards' ? w.items[0].price : '-');
process.exit(0);
