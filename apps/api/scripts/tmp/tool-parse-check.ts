import { createDb } from '../../src/db/client.js';
import { agents } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { AgentConfig } from '@janis/shared';
const db = await createDb();
const [a] = await db.select({ config: agents.config }).from(agents).where(eq(agents.id, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
const parsed = AgentConfig.safeParse(a?.config);
if (!parsed.success) { console.log('AGENTCONFIG FAIL:', JSON.stringify(parsed.error.issues.slice(0,5), null, 1)); process.exit(1); }
const tools = parsed.data.tools ?? [];
console.log('tools parsed:', tools.length);
const st = tools.find((t) => t.name === 'shopify_search_products');
console.log('search widget cfg:', JSON.stringify(st?.widget ?? null).slice(0, 800));
process.exit(0);
