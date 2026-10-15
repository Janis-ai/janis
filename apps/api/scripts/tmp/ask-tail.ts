import { createDb } from '../../src/db/client.js';
import { conversations, messages } from '../../src/db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
const db = await createDb();
const convs = await db.select().from(conversations).where(sql`user_profile->>'kind' = 'merchant_ask'`).orderBy(desc(conversations.lastMessageAt)).limit(3);
for (const cv of convs) {
  console.log('===', cv.id, cv.agentId, cv.externalId);
  const rows = await db.select().from(messages).where(eq(messages.conversationId, cv.id)).orderBy(desc(messages.createdAt)).limit(4);
  for (const m of rows) console.log(m.direction, '|', JSON.stringify(m.text));
}
process.exit(0);
