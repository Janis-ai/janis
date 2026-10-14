import { createDb } from '../../src/db/client.js';
import { messages, conversations } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';

const db = await createDb();
const convId = process.argv[2];
const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
console.log('conv state:', conv?.state, '| externalId:', conv?.externalId, '| userProfile:', JSON.stringify(conv?.userProfile).slice(0, 400));
const msgs = await db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(asc(messages.createdAt)).limit(40);
for (const m of msgs) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const tag = [m.direction, p.internal ? 'internal' : '', p.event ?? '', p.tap ? 'tap' : ''].filter(Boolean).join('/');
  console.log(`\n--- ${tag} ---`);
  console.log((m.text ?? '').slice(0, 500));
  if (p.widgets) console.log('[widgets]', JSON.stringify(p.widgets).slice(0, 300));
}
process.exit(0);
