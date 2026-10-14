import { createDb } from '../../src/db/client.js';
import { shopifyShops } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { connectionToken } from '../../src/lib/connections.js';
import { agentConnections } from '../../src/db/schema.js';
const db = await createDb();
const [conn] = await db.select().from(agentConnections);
// find shopify connection token via secrets map instead
import { loadSecretsMap } from '../../src/lib/secrets.js';
const secrets = await loadSecretsMap(db, 'd408d7b5-fdad-49a4-a34d-11fa16e88135');
const q = `query { products(first:1) { nodes {
  options { name values optionValues { name } }
  sellingPlanGroups(first:5) { nodes { name sellingPlans(first:3) { nodes { name } } } }
} } }`;
const r = await fetch(`https://${secrets.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': secrets.SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: q }),
});
const j = await r.json();
console.log(JSON.stringify(j).slice(0, 1200));
process.exit(0);
