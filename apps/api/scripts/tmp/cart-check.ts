import { createDb } from '../../src/db/client.js';
import { messages, conversations } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.conversationId, process.argv[2])).orderBy(asc(messages.createdAt));
for (const m of rows) {
  const p = (m.payload ?? {}) as any;
  if (m.direction === 'in') console.log(m.createdAt.toISOString().slice(11,19), 'IN', JSON.stringify({ text: (m.text??'').slice(0,50), tap: p.tap, tap_of: p.tap_of, cart: p.cart }));
}
const [c] = await db.select().from(conversations).where(eq(conversations.id, process.argv[2]));
console.log('userProfile.metadata:', JSON.stringify((c.userProfile as any)?.metadata));
