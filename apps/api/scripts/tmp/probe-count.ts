import { createDb } from '../../src/db/client.js';
import { agents } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { toolsFor, callTool } from '../../src/lib/toolExec.js';
import { loadSecretsMap } from '../../src/lib/secrets.js';

const db = await createDb();
const [agent] = await db.select().from(agents).where(eq(agents.id, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
const tool = toolsFor(agent).find((t) => t.name === 'shopify_search_products')!;
const secrets = await loadSecretsMap(db, agent.id);
const res = await callTool(tool, { query: 'status:active' }, secrets);
console.log('result bytes:', res.length);
const d = JSON.parse(res);
console.log('nodes returned:', d.data.products.nodes.length);
// now probe productsCount directly
const shop = secrets.SHOPIFY_SHOP, token = secrets.SHOPIFY_TOKEN;
const r = await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': token, 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'query($q:String!){productsCount(query:$q){count}}', variables: { q: 'status:active' } }),
});
console.log('productsCount:', await r.text());
process.exit(0);
