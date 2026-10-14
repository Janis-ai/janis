import { createDb } from '../../src/db/client.js';
import { conversations, messages } from '../../src/db/schema.js';
import { desc, eq } from 'drizzle-orm';
const db = await createDb();
const [conv] = await db.select().from(conversations)
  .where(eq(conversations.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'))
  .orderBy(desc(conversations.createdAt)).limit(1);
const msgs = await db.select().from(messages)
  .where(eq(messages.conversationId, conv.id))
  .orderBy(desc(messages.createdAt)).limit(2);
const m = msgs[0]; // newest = under800 out
const p = (m.payload ?? {}) as Record<string, unknown>;
const ws = (p.widgets as { type?: string; items?: Record<string,unknown>[] }[] | undefined) ?? [];
console.log('text:', m.text);
console.log('num widgets:', ws.length);
for (const w of ws) {
  console.log('widget type:', w.type, 'items:', w.items?.length);
  for (const i of w.items ?? []) console.log('  -', i.title, '|', i.price, '| stock:', i.stock ?? '-', '| cvid:', i.cart_variant_id ?? '-', '| link_label:', i.link_label);
}
process.exit(0);
