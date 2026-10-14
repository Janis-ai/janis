import { createDb } from '../../src/db/client.js';
import { conversations, messages } from '../../src/db/schema.js';
import { desc, eq } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(conversations).orderBy(desc(conversations.lastMessageAt)).limit(5);
for (const c of rows) {
  const [m] = await db.select({ text: messages.text }).from(messages)
    .where(eq(messages.conversationId, c.id)).orderBy(desc(messages.createdAt)).limit(1);
  console.log(c.id, c.lastMessageAt?.toISOString?.(), '|', (m?.text ?? '').slice(0, 80));
}
process.exit(0);
