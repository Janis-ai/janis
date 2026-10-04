import { createDb } from '../../src/db/client.js';
import { messages, conversations, alerts } from '../../src/db/schema.js';
import { asc, eq } from 'drizzle-orm';
const db = await createDb();
const convs = await db.select().from(conversations);
const conv = convs.find((c) => c.id.startsWith('44dccd1b'))!;
console.log('state:', conv.state);
const ms = await db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(asc(messages.createdAt));
for (const m of ms) {
  const p = (m.payload ?? {}) as { via?: string };
  console.log(m.createdAt.toISOString().slice(11, 19), m.direction.padEnd(3), (m.text ?? '').slice(0, 75).replace(/\n/g, ' '), p.via ? `via=${p.via}` : '');
}
const as = await db.select().from(alerts).where(eq(alerts.conversationId, conv.id));
for (const a of as) console.log('  alert:', a.createdAt.toISOString().slice(11, 19), a.type, a.status);
process.exit(0);
