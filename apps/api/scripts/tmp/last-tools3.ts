import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import { desc, eq, gt } from 'drizzle-orm';
const db = await createDb();
const msgs = await db.select().from(messages)
  .where(eq(messages.conversationId, 'c06c742f-73d7-4445-84cc-853811b3654d'))
  .orderBy(desc(messages.createdAt)).limit(12);
for (const m of msgs.reverse()) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const insp = (p.inspector ?? {}) as { tools?: { name:string; args?:unknown; result?:string; error?:string; outcome?:string }[] };
  const ws = (p.widgets as { type?: string; items?: {title?:string;price?:string;stock?:string;link_label?:string}[] }[] | undefined) ?? [];
  console.log(`\n--- ${m.direction} ---`);
  console.log('text:', String(m.text ?? '').slice(0, 160));
  for (const t of insp.tools ?? []) {
    console.log(' tool:', t.name, JSON.stringify(t.args), 'outcome:', t.outcome, t.error ? `ERR: ${String(t.error).slice(0,150)}` : `result[${String(t.result??'').length}]`);
  }
  for (const w of ws) console.log(' widget:', w.type, (w.items??[]).map(i=>`${i.title}|${i.price}|${i.stock ?? ''}|${i.link_label ?? ''}`).join(' ;; ').slice(0,400));
}
process.exit(0);
