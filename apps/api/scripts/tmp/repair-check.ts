import { createDb } from '../../src/db/client.js';
import { agents } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { callTool, toolsFor } from '../../src/lib/toolExec.js';
import { loadSecretsMap } from '../../src/lib/secrets.js';
import { connectionSecrets } from '../../src/lib/connections.js';
import { repairCardStock, verifyCardItems } from '../../src/lib/hostedAgent.js';
const db = await createDb();
const [a] = await db.select().from(agents).where(eq(agents.id, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
const tool = toolsFor(a!).find((x) => x.name === 'shopify_search_products')!;
const secrets = { ...(await loadSecretsMap(db, a!.id)), ...(await connectionSecrets(db, a!.id)) };
const corpus = await callTool(tool as never, { query: '' }, secrets as never);
console.log('corpus len', corpus.length);
const widgets = [{ type: 'cards', items: [
  { title: 'The Videographer Snowboard', price: 'USD 885.95', link_label: 'View Product', link: 'https://x' },
  { title: 'Gift Card', link_label: 'View Gift Card' },
] }] as never[];
const dropped = verifyCardItems(widgets, corpus, new Set(), true);
console.log('dropped:', dropped, 'remaining:', JSON.stringify(widgets).slice(0, 300));
const fixed = repairCardStock(widgets, corpus);
console.log('fixed:', fixed, JSON.stringify(widgets).slice(0, 600));
process.exit(0);
