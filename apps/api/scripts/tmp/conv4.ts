import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages)
  .where(eq(messages.conversationId, 'e276eb52-f3a0-4f0b-bcc2-142f53ea64a4'))
  .orderBy(asc(messages.createdAt));
for (const m of rows) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  console.log(`\n=== ${m.createdAt?.toISOString()} [${m.direction}]`);
  if (m.text) console.log('  text:', m.text.slice(0, 300));
  const w = (p.widgets ?? []) as any[];
  for (const x of w) console.log('  widget:', x.type, 'items:', x.items?.length ?? '—');
  const tools = (p.tools ?? p.tool_calls ?? []) as any[];
  for (const t of tools) console.log('  tool:', t.name ?? t.tool, '→', JSON.stringify(t.status ?? t.error ?? '').slice(0, 120));
  if (p.error) console.log('  ERROR:', JSON.stringify(p.error).slice(0, 300));
  if (p.internal) console.log('  internal:', JSON.stringify(p.internal).slice(0, 300));
}
process.exit(0);
