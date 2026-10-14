import { createDb } from '../../src/db/client.js';
import { agents } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { callTool, toolsFor } from '../../src/lib/toolExec.js';
import { loadSecretsMap } from '../../src/lib/secrets.js';
import { connectionSecrets } from '../../src/lib/connections.js';
const db = await createDb();
const [a] = await db.select().from(agents).where(eq(agents.id, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'));
const tool = toolsFor(a!).find((x) => x.name === 'shopify_search_products')!;
const secrets = { ...(await loadSecretsMap(db, a!.id)), ...(await connectionSecrets(db, a!.id)) };
const corpus = await callTool(tool as never, { query: '' }, secrets as never);
const re = /"title"\s*:\s*"The Videographer Snowboard"/;
const m = re.exec(corpus);
console.log('title match:', m?.index);
if (m) {
  const rest = corpus.slice(m.index);
  const next = rest.indexOf('"title"', 10);
  const span = next === -1 ? rest.slice(0, 8000) : rest.slice(0, next);
  console.log('span:', span.slice(0, 300));
  console.log('variant ids:', [...span.matchAll(/"id"\s*:\s*"gid:\/\/shopify\/ProductVariant\/(\d+)"/g)].map(x=>x[1]));
  console.log('avail:', /"availableForSale"\s*:\s*(true|false)/.exec(span)?.[1]);
  console.log('price:', /"price"\s*:\s*"?([\d.]+)"?/.exec(span)?.[1]);
}
process.exit(0);
