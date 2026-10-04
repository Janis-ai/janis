import { createDb } from '../../src/db/client.js';
import { conversations, messages, pendingActions } from '../../src/db/schema.js';
import { and, desc, eq } from 'drizzle-orm';
const db = await createDb();
// anon convo — newest conv on Smoke Test Bot
const [b] = await db.select().from(conversations).where(eq(conversations.agentId, 'd951d208-0ac9-4b36-ac60-77775fe2ace8')).orderBy(desc(conversations.createdAt)).limit(1);
if (b) {
  const ms = await db.select().from(messages).where(eq(messages.conversationId, b.id)).orderBy(desc(messages.createdAt)).limit(25);
  console.log('anon conv', b.id, b.state, '| msgs:', ms.length);
  const ins = ms.filter(m => m.direction === 'in').length, outs = ms.filter(m => m.direction === 'out').length;
  console.log(`  in=${ins} out=${outs}`);
  for (const m of ms.slice(0, 6)) console.log(' ', m.direction, (m.text ?? '').slice(0, 90).replace(/\n/g, ' '));
}
// pending actions remaining
const p = await db.select({ id: pendingActions.id, status: pendingActions.status, action: pendingActions.action }).from(pendingActions).where(eq(pendingActions.conversationId, '1fb291f8-c3f9-422d-bf3d-09766829efb6')).orderBy(desc(pendingActions.createdAt)).limit(15);
for (const a of p) console.log('action:', a.id.slice(0,8), a.status, JSON.stringify(a.action).slice(0,110));
process.exit(0);
