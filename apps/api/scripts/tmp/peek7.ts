import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, desc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages)
  .where(eq(messages.conversationId, '26beb247-55b4-47f6-9be7-0aa4f58afb63'))
  .orderBy(desc(messages.createdAt)).limit(30);
for (const m of rows.reverse()) {
  if (m.text?.includes('Videographer') || m.text?.includes('××') || m.text?.includes('Minimal'))
    console.log('---', m.direction, m.createdAt, '\n', m.text);
}
process.exit(0);
