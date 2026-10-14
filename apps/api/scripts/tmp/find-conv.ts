import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { gt, asc, desc, and, eq } from 'drizzle-orm';
const db = await createDb();
const since = new Date(Date.now() - 25 * 60_000);
// find the storefront conversation: look for messages containing 'ski wax' or 'snowboard'
const rows = await db.select().from(messages).where(gt(messages.createdAt, since)).orderBy(desc(messages.createdAt)).limit(300);
const hits = rows.filter(m => /ski wax|snowboard|in stock|selling plans/i.test(JSON.stringify(m.payload ?? '') + ' ' + (m as any).text ?? ''));
const convs = [...new Set(hits.map(m => m.conversationId))];
console.log('conversations with shopify content:', convs.slice(0,5));
const conv = convs[0];
if (!conv) { process.exit(0); }
const thread = await db.select().from(messages).where(and(eq(messages.conversationId, conv), gt(messages.createdAt, since))).orderBy(asc(messages.createdAt));
for (const m of thread) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const at = m.createdAt.toISOString().slice(11,19);
  const tools = (p.inspector as {tools?: {name?:string; args?:unknown}[]})?.tools?.map(t=>`${t.name}(${JSON.stringify(t.args).slice(0,60)})`).join(', ') ?? '';
  const widgets = Array.isArray(p.widgets) ? (p.widgets as {type?:string; items?: {title?:string}[]}[]).map(w=>`${w.type}:${(w.items||[]).map(i=>i.title).join(';').slice(0,120)}`).join(' || ') : '';
  const txt = (p.text ?? m.text ?? '') as string;
  console.log(`${at} ${m.direction.padEnd(4)} ${txt.slice(0,90).replace(/\n/g,' ')}`);
  if (tools) console.log(`     TOOLS: ${tools}`);
  if (widgets) console.log(`     WIDGETS: ${widgets}`);
}
process.exit(0);
