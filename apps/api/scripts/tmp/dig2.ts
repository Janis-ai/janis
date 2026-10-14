import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { gt, and, eq, desc } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.select().from(messages)
  .where(and(gt(messages.createdAt, new Date('2026-10-14T01:20:00Z')), eq(messages.direction, 'out')))
  .orderBy(desc(messages.createdAt));
for (const m of msgs) {
  if (!/more of our products|set that up|currently out of stock. Would/i.test(m.text ?? '')) continue;
  const p = (m.payload as any) ?? {};
  const tools = (p.inspector?.tools ?? []).map((t:any)=>`${t.name}(${JSON.stringify(t.args)})→${t.outcome}`);
  console.log('===', (m.text ?? '').slice(0, 80));
  console.log('   tools:', tools.join(' ; ') || 'none');
  console.log('   chips:', JSON.stringify(p.quick_replies ?? null));
}
process.exit(0);
