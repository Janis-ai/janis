import '../src/loadEnv.js';
import { createDb } from '../src/db/client.js';
import { agents } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { rewritePrompt } from '../src/lib/agentTests.js';

const db = await createDb();
const [agent] = await db.select().from(agents).where(eq(agents.id, '13e45248-77e9-4006-b8a5-76c442e522bd'));
// No conflicts passed — exercises the internal audit fallback.
const res = await rewritePrompt(db, agent);
if (!res) { console.log('rewrite: null'); process.exit(0); }
console.log('--- rewrite ---\n' + res.rewrite);
console.log('--- review ---\n' + JSON.stringify(res.review, null, 2));
process.exit(0);
