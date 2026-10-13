import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages)
  .where(eq(messages.conversationId, '26beb247-55b4-47f6-9be7-0aa4f58afb63'))
  .orderBy(desc(messages.createdAt)).limit(6);
for (const m of rows) console.log('---', m.direction, m.createdAt, '\n', m.text?.slice(0, 800));
process.exit(0);
