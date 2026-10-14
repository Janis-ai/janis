import { createDb } from '../../src/db/client.js';
import { conversations, messages } from '../../src/db/schema.js';
import { desc, eq } from 'drizzle-orm';
const db = await createDb();
const [conv] = await db.select().from(conversations)
  .where(eq(conversations.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'))
  .orderBy(desc(conversations.createdAt)).limit(1);
console.log('conv:', conv.id, conv.createdAt);
const msgs = await db.select().from(messages)
  .where(eq(messages.conversationId, conv.id))
  .orderBy(desc(messages.createdAt)).limit(6);
for (const m of msgs.reverse()) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const tools = (p.inspector as { tools?: { name: string }[] } | undefined)?.tools ?? [];
  console.log(`\n--- ${m.direction} ${m.createdAt} ---`);
  console.log('text:', String(m.text ?? '').slice(0, 200));
  console.log('tools:', JSON.stringify(tools.map(t => t.name)));
  const ws = (p.widgets as { type?: string; items?: {title?:string}[] }[] | undefined) ?? [];
  console.log('widgets:', ws.map(w => `${w.type}(${(w.items??[]).length})`).join(',') || 'none');
}
process.exit(0);
