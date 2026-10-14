import { createDb } from '../../src/db/client.js';
import { agents } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { toolsFor, callTool } from '../../src/lib/toolExec.js';
import { widgetFromToolResult } from '../../src/lib/widgets.js';
import { loadSecretsMap } from '../../src/lib/secrets.js';

const db = await createDb();
const [agent] = await db.select().from(agents).where(eq(agents.id, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
const tool = toolsFor(agent).find((t) => t.name === 'shopify_search_products')!;
console.log('stored price map:', tool.widget?.map?.price);
const secrets = await loadSecretsMap(db, agent.id);
const res = await callTool(tool, { query: 'title:*ski wax* status:active' }, secrets);
const w = widgetFromToolResult(tool.widget!, res, secrets);
console.log('card:', JSON.stringify(w?.type === 'cards' ? w.items[0] : w).slice(0, 500));
process.exit(0);
