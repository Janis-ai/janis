import { createDb } from '../../src/db/client.js';
import { conversations, messages } from '../../src/db/schema.js';
import { desc, eq } from 'drizzle-orm';
const db = await createDb();
const [conv] = await db.select().from(conversations)
  .where(eq(conversations.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'))
  .orderBy(desc(conversations.createdAt)).limit(1);
const msgs = await db.select().from(messages)
  .where(eq(messages.conversationId, conv.id))
  .orderBy(desc(messages.createdAt)).limit(8);
for (const m of msgs.reverse()) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const insp = (p.inspector ?? {}) as { tools?: { name:string; args?:unknown; outcome?:string; error?:string }[] };
  const ws = (p.widgets as { type?: string; items?: Record<string,unknown>[] }[] | undefined) ?? [];
  console.log(`\n--- ${m.direction} ---`);
  console.log('text:', String(m.text ?? '').slice(0, 120));
  for (const t of insp.tools ?? []) console.log(' tool:', t.name, JSON.stringify(t.args), t.outcome, t.error ? String(t.error).slice(0,120) : '');
  for (const w of ws) console.log(' widget:', w.type, JSON.stringify(w.items).slice(0, 600));
}
process.exit(0);
