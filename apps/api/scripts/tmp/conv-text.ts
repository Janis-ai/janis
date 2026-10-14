import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.conversationId, '4b3994ee-e359-4151-882c-d79a7e26a681')).orderBy(asc(messages.createdAt));
for (const m of rows) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const txt = (p.text ?? m.text ?? '') as string;
  console.log(`\n[${m.direction} ${m.createdAt.toISOString().slice(11,19)}] ${txt.slice(0, 700)}`);
}
process.exit(0);
