import '../src/loadEnv.js';
import fs from 'node:fs';
import { createDb } from '../src/db/client.js';
import { agents } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { checkPromptConflicts } from '../src/lib/agentTests.js';

// Check-only — audits the agent's SAVED instructions. Pass --sync to
// first write the canonical concierge-persona.txt into the agent
// (previously ran on every invocation and clobbered test text).
const db = await createDb();
if (process.argv.includes('--sync')) {
  const persona = fs.readFileSync('scripts/concierge-persona.txt', 'utf8').trim();
  const [cur] = await db.select().from(agents).where(eq(agents.id, '13e45248-77e9-4006-b8a5-76c442e522bd'));
  await db
    .update(agents)
    .set({ config: { ...(cur?.config as object), system_prompt: persona } })
    .where(eq(agents.id, '13e45248-77e9-4006-b8a5-76c442e522bd'));
  console.log('synced canonical persona into dev concierge.');
}
const [agent] = await db.select().from(agents).where(eq(agents.id, '13e45248-77e9-4006-b8a5-76c442e522bd'));
const result = await checkPromptConflicts(db, agent);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
