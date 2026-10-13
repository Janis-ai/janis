import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { refreshKnowledgeSource } from '../../src/lib/urlSource.js';
import { knowledgeFiles } from '../../src/db/schema.js';
import { eq, and, isNull, sql } from 'drizzle-orm';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const db = await createDb();
const rows = await db.select().from(knowledgeFiles).where(and(
  eq(knowledgeFiles.agentId, 'f454f596-338a-431f-b604-68535303317b'),
  isNull(knowledgeFiles.imageUrl),
  sql`source_url is not null`,
));
console.log('refreshing', rows.length, 'rows with 4s spacing');
let ok = 0, failed = 0;
for (const f of rows) {
  await refreshKnowledgeSource(db, f);
  const [after] = await db.select({ status: knowledgeFiles.status, imageUrl: knowledgeFiles.imageUrl })
    .from(knowledgeFiles).where(eq(knowledgeFiles.id, f.id));
  if (after.status !== 'ready') {
    failed++;
    // Never leave a last-good doc out of the KB on a transient fetch failure.
    await db.update(knowledgeFiles).set({ status: 'ready', error: null }).where(eq(knowledgeFiles.id, f.id));
    console.log('FAIL (restored ready):', f.name);
  } else { ok++; }
  await sleep(4000);
}
console.log('done:', ok, 'ok,', failed, 'failed-and-restored');
process.exit(0);
