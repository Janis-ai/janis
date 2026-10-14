import { createDb } from '../../src/db/client.js';
import { messages, conversations } from '../../src/db/schema.js';
import { eq, desc, asc } from 'drizzle-orm';
const db = await createDb();
const convs = await db.select().from(conversations).where(eq(conversations.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135')).orderBy(desc(conversations.createdAt)).limit(1);
const conv = convs[0];
console.log('conv:', conv.id, conv.createdAt.toISOString());
const rows = await db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(asc(messages.createdAt));
for (const m of rows) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  if (m.direction !== 'out') continue;
  const tools = (p.inspector as {tools?: {name?:string; args?:unknown; result?:string[]}[]})?.tools ?? [];
  const tstr = tools.map(t=>`${t.name}(${JSON.stringify(t.args)})`).join(' | ');
  const widgets = Array.isArray(p.widgets) ? (p.widgets as {type?:string; items?: {title?:string;stock?:string}[]; total?:number}[]).map(w=>`${w.type}(${(w.items||[]).length}${w.total?'/'+w.total:''}):${(w.items||[]).map(i=>i.title+(i.stock?'[OOS]':'')).join(';')}`).join(' || ') : '';
  console.log(`\n${m.createdAt.toISOString().slice(11,19)} OUT: ${String(p.text ?? '').slice(0,120).replace(/\n/g,' | ')}`);
  if (tstr) console.log(`   TOOLS: ${tstr.slice(0,200)}`);
  if (widgets) console.log(`   WIDGETS: ${widgets.slice(0,260)}`);
}
process.exit(0);
