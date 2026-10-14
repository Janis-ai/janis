import { createDb } from '../../src/db/client.js';
import { messages, conversations } from '../../src/db/schema.js';
import { desc, gt, and, eq } from 'drizzle-orm';
const db = await createDb();
// find the storefront conv with the 9:05 gift-card exchange
const convs = await db.select().from(conversations).where(gt(conversations.createdAt, new Date('2026-10-14T00:50:00Z'))).orderBy(desc(conversations.createdAt)).limit(10);
for (const c of convs) console.log('conv', c.id, c.channelId?.slice(0,8), c.createdAt?.toISOString());
const rows = await db.select().from(messages).where(gt(messages.createdAt, new Date('2026-10-14T00:55:00Z'))).orderBy(messages.createdAt);
for (const m of rows) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  console.log(`\n=== ${m.createdAt?.toISOString()} [${m.direction}] ${(m.text ?? '').slice(0, 110)}`);
  const tools = (p.tool_calls ?? p.tools ?? []) as any[];
  for (const t of tools) console.log('  tool:', t.name, JSON.stringify(t.args ?? t.input ?? {}).slice(0, 140), '→', (t.status ?? '').toString().slice(0,40));
  for (const w of (p.widgets ?? []) as any[]) console.log('  widget:', w.type, w.items?.map?.((i:any)=>i.title));
  const insp = p.inspector as any;
  if (insp?.runs) for (const r of insp.runs) console.log('  issues:', JSON.stringify(r.issues ?? r.run_issues ?? []));
}
process.exit(0);
