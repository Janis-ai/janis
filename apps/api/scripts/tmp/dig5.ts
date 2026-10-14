import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { gt, and, eq, asc } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.select().from(messages)
  .where(and(gt(messages.createdAt, new Date('2026-10-14T01:50:00Z')), eq(messages.direction, 'out')))
  .orderBy(asc(messages.createdAt));
for (const m of msgs) {
  if (!/15 active|unable to verify|rest|what about the videographer/i.test(m.text ?? '') || /remaining|previous draft/.test(m.text ?? '')) continue;
  const p = (m.payload as any) ?? {};
  console.log('===', (m.text ?? '').slice(0, 80));
  console.log('   tools:', (p.inspector?.tools ?? []).map((t:any)=>`${t.name}(${JSON.stringify(t.args)})→${t.outcome}`).join(' ; ') || 'none');
}
process.exit(0);
