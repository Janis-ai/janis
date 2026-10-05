import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { agents } from '../../src/db/schema.js';
const db = await createDb();
const rows = await db.select({ id: agents.id, name: agents.name, hosted: agents.hosted, config: agents.config }).from(agents);
for (const a of rows) {
  const engine = (a.config as { engine?: string })?.engine ?? 'hosted';
  console.log(`${a.name.padEnd(20)} hosted=${a.hosted} engine=${engine}`);
}
process.exit(0);
