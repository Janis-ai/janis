import '../src/loadEnv.js';
import fs from 'node:fs';
import { createDb } from '../src/db/client.js';
import { agents } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { checkPromptConflicts } from '../src/lib/agentTests.js';

const db = await createDb();
const persona = fs.readFileSync('scripts/concierge-persona.txt', 'utf8').trim();

// Restore dev concierge to canonical file (Mike's save clobbered it with
// the stale variant), then audit the saved text.
await db
  .update(agents)
  .set({ config: Object.assign({}, (await db.select().from(agents).where(eq(agents.id, '13e45248-77e9-4006-b8a5-76c442e522bd')))[0]?.config as object, { system_prompt: persona }) })
  .where(eq(agents.id, '13e45248-77e9-4006-b8a5-76c442e522bd'));
const [agent] = await db.select().from(agents).where(eq(agents.id, '13e45248-77e9-4006-b8a5-76c442e522bd'));
console.log('synced, running check…');
const conflicts = await checkPromptConflicts(db, agent);
console.log(JSON.stringify(conflicts, null, 2));
process.exit(0);
