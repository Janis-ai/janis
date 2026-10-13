import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { eq, isNotNull, and } from 'drizzle-orm';
import { refreshKnowledgeSource } from '../../src/lib/urlSource.js';
import { knowledgeFiles } from '../../src/db/schema.js';
const db = await createDb();
const rows = await db
  .select()
  .from(knowledgeFiles)
  .where(
    and(
      eq(knowledgeFiles.agentId, 'f454f596-338a-431f-b604-68535303317b'),
      eq(knowledgeFiles.status, 'failed'),
      isNotNull(knowledgeFiles.sourceUrl),
    ),
  );
let ok = 0, imgs = 0;
for (const r of rows) {
  const done = await refreshKnowledgeSource(db, r);
  if (done) { ok++; if (r.imageUrl) imgs++; }
}
console.log(`refreshed ${ok}/${rows.length}, ${imgs} with image_url`);
const [one] = await db.select({ name: knowledgeFiles.name, imageUrl: knowledgeFiles.imageUrl })
  .from(knowledgeFiles)
  .where(eq(knowledgeFiles.name, 'https://jonathanferrier.com/properties/44-moberly-avenue'));
console.log(JSON.stringify(one));
process.exit(0);
