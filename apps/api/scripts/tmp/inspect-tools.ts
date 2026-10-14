import { createDb } from '../../src/db/client.js';
import { messages, conversations } from '../../src/db/schema.js';
import { eq, desc, and, gt } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.select().from(messages)
  .where(and(gt(messages.createdAt, new Date('2026-10-14T01:20:00Z')), eq(messages.direction, 'out')))
  .orderBy(desc(messages.createdAt)).limit(30);
for (const m of msgs) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const calls = (p.inspector as any)?.toolCalls ?? (p.inspector as any)?.runs?.flatMap((r: any) => r.toolCalls ?? []) ?? [];
  if (!calls.length && !(m.text ?? '').match(/hidden|15|stock items|rest/)) continue;
  console.log('\n===', (m.text ?? '').slice(0, 90));
  for (const t of calls) {
    console.log('  tool:', t.name, '| args:', JSON.stringify(t.args ?? t.input).slice(0, 200));
    const res = String(t.result ?? t.output ?? '').slice(0, 400);
    if (res) console.log('        →', res.slice(0, 350));
  }
}
process.exit(0);
