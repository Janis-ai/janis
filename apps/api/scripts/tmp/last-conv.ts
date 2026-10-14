import { createDb } from '../../src/db/client.js';
import { messages, conversations } from '../../src/db/schema.js';
import { eq, desc, gt, asc } from 'drizzle-orm';
const db = await createDb();
const [latest] = await db.select({ conversationId: messages.conversationId }).from(messages)
  .where(gt(messages.createdAt, new Date(Date.now() - 15 * 60_000))).orderBy(desc(messages.createdAt)).limit(1);
const rows = await db.select().from(messages).where(eq(messages.conversationId, latest.conversationId)).orderBy(asc(messages.createdAt));
for (const m of rows) {
  const p = (m.payload ?? {}) as any;
  const items = (p.widgets ?? []).flatMap((w: any) => (w.items ?? []).map((i: any) => i.title));
  const totals = (p.widgets ?? []).map((w: any) => w.total).filter(Boolean);
  console.log(m.createdAt.toISOString().slice(11,19), m.direction, (m.text ?? '').replace(/\n/g,' ').slice(0,80));
  if (items.length) console.log('      items:', JSON.stringify(items));
  if (totals.length) console.log('      totals:', totals);
  if (p.inspector?.tools) console.log('      tools:', JSON.stringify(p.inspector.tools.map((t:any)=>t.args).slice(0,3)));
}
