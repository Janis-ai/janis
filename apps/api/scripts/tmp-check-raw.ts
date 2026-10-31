import '../src/loadEnv.js';
import { createDb } from '../src/db/client.js';
import { agents } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';

// Generation-only probe: replicate checkPromptConflicts' FIRST call to
// see raw findings before the verify pass drops any.
import { llmFor } from '../src/lib/llm.js';
import { complete } from '../src/lib/llm.js';
const db = await createDb();
const [agent] = await db.select().from(agents).where(eq(agents.id, '13e45248-77e9-4006-b8a5-76c442e522bd'));
const { checkPromptConflicts } = await import('../src/lib/agentTests.js');
// Run the full pipeline 3x — findings vs dismissed tells us who ate what.
for (let i = 0; i < 3; i++) {
  const r = await checkPromptConflicts(db, agent);
  console.log(`run ${i}:`, JSON.stringify(r?.conflicts.map(c => ({a: c.a.slice(0,50), b: c.b.slice(0,50)})), null, 0), 'dismissed:', r?.dismissed);
}
process.exit(0);
