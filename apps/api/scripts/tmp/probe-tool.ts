import { createDb } from '../../src/db/client.js';
import { agents } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { loadSecretsMap } from '../../src/lib/secrets.js';
import { callTool, type ToolDef } from '../../src/lib/toolExec.js';

const db = await createDb();
const [a] = await db.select().from(agents).where(eq(agents.id, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
const tools = (a!.config as any).tools as ToolDef[];
const t = tools.find((x) => x.name === 'shopify_search_products')!;
console.log('stored def params:', JSON.stringify(t.params), '\nwidget:', JSON.stringify(t.widget?.map ?? null));
const secrets = await loadSecretsMap(db, a!.id);
for (const q of ['status:active', 'title:*ski wax* status:active', 'ski wax', 'wax', '*']) {
  const r = await callTool(t, { query: q }, secrets);
  console.log('===', JSON.stringify(q), '→', r.slice(0, 400));
}
process.exit(0);
