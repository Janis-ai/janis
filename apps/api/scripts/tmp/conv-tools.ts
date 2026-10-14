import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const rows = await db.select().from(messages).where(eq(messages.conversationId, process.argv[2])).orderBy(asc(messages.createdAt));
for (const m of rows) {
  const p = (m.payload ?? {}) as any;
  if (m.direction !== 'out') { console.log(`\n${m.createdAt.toISOString().slice(11,19)} IN  ${(m.text??'').slice(0,80)}${p.tap?' [tap:'+p.tap_of+']':''}`); continue; }
  console.log(`\n${m.createdAt.toISOString().slice(11,19)} OUT ${(m.text??'').slice(0,100)}`);
  for (const t of p.inspector?.tools ?? []) console.log(`     tool ${t.name} args=${JSON.stringify(t.args).slice(0,120)} outcome=${t.outcome} out=${JSON.stringify(t.output??t.result??'').slice(0,200)}`);
  console.log(`     widgets=${JSON.stringify((p.widgets??[]).map((w:any)=>({t:w.type,n:w.items?.length})))} chips=${JSON.stringify(p.quick_replies)}`);
}
