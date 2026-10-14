import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { gt, and, eq, asc, desc } from 'drizzle-orm';

const db = await createDb();
const minutes = Number(process.env.MINUTES ?? 10);
const since = new Date(Date.now() - minutes * 60_000);

// newest message in the window → its conversation
const [latest] = await db
  .select({ conversationId: messages.conversationId })
  .from(messages)
  .where(gt(messages.createdAt, since))
  .orderBy(desc(messages.createdAt))
  .limit(1);
if (!latest) {
  console.log('no messages in window');
  process.exit(0);
}

const rows = await db
  .select()
  .from(messages)
  .where(and(eq(messages.conversationId, latest.conversationId), gt(messages.createdAt, since)))
  .orderBy(asc(messages.createdAt));

for (const m of rows) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const at = m.createdAt.toISOString().slice(11, 19);
  const covers = typeof p.covers_through === 'string' ? p.covers_through.slice(11, 19) : '';
  const internal = p.internal === true ? '[int] ' : '';
  const text = (m.text ?? '').replace(/\n/g, ' ').slice(0, 75);
  console.log(at, m.direction.padEnd(6), internal + text, covers ? `covers:${covers}` : '', `[len=${(m.text ?? '').length}]`);
}
