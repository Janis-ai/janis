import { createDb } from '../../src/db/client.js';
import { conversations, messages } from '../../src/db/schema.js';
import { desc, eq } from 'drizzle-orm';
const db = await createDb();
const convs = await db.select().from(conversations)
  .where(eq(conversations.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'))
  .orderBy(desc(conversations.createdAt)).limit(3);
for (const c of convs) console.log('conv:', c.id, c.createdAt);
const conv = convs[0];
const msgs = await db.select().from(messages)
  .where(eq(messages.conversationId, conv.id))
  .orderBy(desc(messages.createdAt)).limit(16);
for (const m of msgs.reverse()) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const insp = (p.inspector ?? {}) as { tools?: { name:string; args?:unknown; result?:string; error?:string; outcome?:string }[] };
  const ws = (p.widgets as { type?: string; items?: {title?:string;price?:string;stock?:string;link_label?:string;cart_variant_id?:string}[] }[] | undefined) ?? [];
  console.log(`\n--- ${m.direction} ---`);
  console.log('text:', String(m.text ?? '').slice(0, 140));
  for (const t of insp.tools ?? []) {
    console.log(' tool:', t.name, JSON.stringify(t.args), 'outcome:', t.outcome, t.error ? `ERR:${String(t.error).slice(0,140)}` : `result[${String(t.result??'').length}]`);
  }
  for (const w of ws) console.log(' widget:', w.type, (w.items??[]).map(i=>`${i.title}|${i.price}|${i.stock ?? '-'}|cvid:${i.cart_variant_id ? 'y':'n'}`).join(' ;; ').slice(0,420));
}
process.exit(0);
