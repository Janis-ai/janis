import { createDb } from '../../src/db/client.js';
import { messages, conversations } from '../../src/db/schema.js';
import { gt, and, eq, asc } from 'drizzle-orm';
const db = await createDb();
// find convs on the shopify channel with recent traffic
const convs = await db.select().from(conversations)
  .where(and(eq(conversations.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'), gt(conversations.createdAt, new Date('2026-10-14T02:00:00Z'))))
  .orderBy(asc(conversations.createdAt));
for (const c of convs) {
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, c.id)).orderBy(asc(messages.createdAt));
  const userMsgs = msgs.filter(m => m.direction === 'in');
  if (userMsgs.length < 4) continue; // skip partial convs
  console.log(`\n######## conv ${c.id} (${msgs.length} msgs)`);
  for (const m of msgs) {
    const p = (m.payload ?? {}) as any;
    const w = (p.widgets ?? []).flatMap((w: any) => w.type === 'cards' ? (w.items ?? []).map((i: any) => `${i.title}${i.stock ? ' [OOS]' : ''}`) : [w.type]);
    const q = (p.quick_replies ?? []).map((b: any) => typeof b === 'string' ? b : b.type);
    console.log(`--- ${m.direction} ${m.createdAt.toISOString().slice(11,19)}`);
    console.log(`    ${(m.text ?? '').slice(0, 200)}`);
    if (w.length) console.log(`    cards: ${w.join(' | ')}`);
    if (q.length) console.log(`    chips: ${q.join(' | ')}`);
    const tools = (p.inspector?.tools ?? []).map((t: any) => `${t.name}(${JSON.stringify(t.args)})`);
    if (tools.length) console.log(`    tools: ${tools.join(' ; ')}`);
  }
}
process.exit(0);
