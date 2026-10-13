import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { eq, isNotNull, isNull, and } from 'drizzle-orm';
import { refreshKnowledgeSource } from '../../src/lib/urlSource.js';
import { knowledgeFiles } from '../../src/db/schema.js';
const db = await createDb();
const rows = await db
  .select()
  .from(knowledgeFiles)
  .where(
    and(
      eq(knowledgeFiles.agentId, 'f454f596-338a-431f-b604-68535303317b'),
      isNotNull(knowledgeFiles.sourceUrl),
      isNull(knowledgeFiles.imageUrl),
    ),
  );
let ok = 0, imgs = 0;
for (const r of rows) {
  if (await refreshKnowledgeSource(db, r)) {
    ok++;
    const [f] = await db.select({ imageUrl: knowledgeFiles.imageUrl }).from(knowledgeFiles).where(eq(knowledgeFiles.id, r.id));
    if (f?.imageUrl) imgs++;
  }
}
console.log(`refreshed ${ok}/${rows.length}, ${imgs} with image_url`);
process.exit(0);
