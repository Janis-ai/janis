import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.conversationId, '2ffb9c1f-d92b-46b2-a0f7-ab6a90293e28')).orderBy(asc(messages.createdAt));
for (const m of rows.slice(-12)) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const at = m.createdAt.toISOString().slice(5, 19);
  const tools = (p.inspector as {tools?: {name?:string; args?:unknown}[]})?.tools?.map(t=>`${t.name}(${JSON.stringify(t.args).slice(0,60)})`).join(', ') ?? '';
  const widgets = Array.isArray(p.widgets) ? (p.widgets as {type?:string; items?: {title?:string}[]}[]).map(w=>`${w.type}(${(w.items||[]).length}):${(w.items||[]).map(i=>i.title).join(';').slice(0,90)}`).join(' || ') : '';
  console.log(`\n${at} ${m.direction}: ${String(p.text ?? m.text ?? '').slice(0,200).replace(/\n/g,' | ')}`);
  if (tools) console.log(`   TOOLS: ${tools}`);
  if (widgets) console.log(`   WIDGETS: ${widgets}`);
}
process.exit(0);
