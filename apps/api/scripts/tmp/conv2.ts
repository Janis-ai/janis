import { createDb } from '../../src/db/client.js';
import { conversations, messages } from '../../src/db/schema.js';
import { eq, desc, and, isNotNull } from 'drizzle-orm';
const db = await createDb();
// find the conv containing the photo question
const rows = await db.select().from(messages)
  .where(and(eq(messages.direction, 'in'), isNotNull(messages.text)))
  .orderBy(desc(messages.createdAt)).limit(60);
for (const m of rows) {
  if ((m.text ?? '').includes('looks like')) console.log('FOUND', m.conversationId, m.createdAt?.toISOString(), JSON.stringify(m.text?.slice(0,80)));
}
const [conv] = await db.select().from(conversations).where(eq(conversations.id, '0e19e4aa-69aa-42ff-a17c-328403bbc145'));
console.log('channel conv:', conv?.createdAt?.toISOString());
process.exit(0);
