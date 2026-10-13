import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { refreshKnowledgeSource } from '../../src/lib/urlSource.js';
import { knowledgeFiles } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const [f] = await db.select().from(knowledgeFiles).where(eq(knowledgeFiles.sourceUrl, 'https://jonathanferrier.com/properties/103-woodlawn-avenue-west'));
if (!f) { console.log('not found'); process.exit(0); }
await refreshKnowledgeSource(db, f);
const [after] = await db.select({ status: knowledgeFiles.status, imageUrl: knowledgeFiles.imageUrl, err: knowledgeFiles.error }).from(knowledgeFiles).where(eq(knowledgeFiles.id, f.id));
console.log(after);
process.exit(0);
