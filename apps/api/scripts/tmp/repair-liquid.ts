import { createDb } from '../../src/db/client.js';
import { agents } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { callTool, toolsFor } from '../../src/lib/toolExec.js';
import { loadSecretsMap } from '../../src/lib/secrets.js';
import { connectionSecrets } from '../../src/lib/connections.js';
import { repairCardStock } from '../../src/lib/hostedAgent.js';
const db = await createDb();
const [a] = await db.select().from(agents).where(eq(agents.id, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
const tool = toolsFor(a!).find((x) => x.name === 'shopify_search_products')!;
const secrets = { ...(await loadSecretsMap(db, a!.id)), ...(await connectionSecrets(db, a!.id)) };
const corpus = await callTool(tool as never, { query: 'product_type:snowboard' }, secrets as never);
console.log('corpus len', corpus.length, 'has Liquid:', corpus.includes('"The Collection Snowboard: Liquid"'));
const widgets = [{ type: 'cards', items: [
  { title: 'The Collection Snowboard: Liquid', price: 'USD 749.95', link_label: 'View Product' },
] }] as never[];
console.log('fixed:', repairCardStock(widgets, corpus), JSON.stringify(widgets[0].items[0]));
process.exit(0);
