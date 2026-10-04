import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { messages, conversations } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const db = await createDb();
const [c] = await db.select().from(conversations).where(eq(conversations.id, '94d4643c-a770-4a80-9b35-02d81ed55b6e')).limit(1);
const rows = await db.select().from(messages).where(eq(messages.conversationId, c.id)).orderBy(desc(messages.createdAt)).limit(8);
for (const m of rows.reverse())
  console.log(m.createdAt.toISOString().slice(11, 19), m.direction.padEnd(5), JSON.stringify(m.payload).slice(0, 90), '|', JSON.stringify(m.flags), '|', (m.text ?? '').slice(0, 90));
process.exit(0);
