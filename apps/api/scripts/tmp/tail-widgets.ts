import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.conversationId, process.argv[2]!)).orderBy(asc(messages.createdAt));
const tail = rows.filter((m) => m.createdAt.toISOString() >= (process.argv[3] ?? '1970'));
for (const m of tail) {
  console.log('\n===', m.createdAt.toISOString().slice(11, 19), m.direction, (m.text ?? '').slice(0, 150));
  const w = (m.payload as any)?.widgets;
  if (w) console.log(JSON.stringify(w).slice(0, 1400));
}
process.exit(0);
