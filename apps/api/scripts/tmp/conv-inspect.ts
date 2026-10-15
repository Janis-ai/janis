import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.conversationId, process.argv[2]!)).orderBy(asc(messages.createdAt));
for (const m of rows.slice(-5)) {
  console.log(`--- ${m.direction} @ ${m.createdAt.toISOString()}`);
  console.log(m.text);
  const flags = m.flags as any;
  if (flags && Object.values(flags).some(Boolean)) console.log('FLAGS:', JSON.stringify(flags));
  if (m.payload?.tap) console.log('TAP:', JSON.stringify(m.payload.tap));
}
