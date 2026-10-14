import { createDb } from '../../src/db/client.js';
import { messages, conversations } from '../../src/db/schema.js';
import { eq, asc, desc } from 'drizzle-orm';
const db = await createDb();
const conv = process.argv[2] ?? (await db.select({ id: conversations.id }).from(conversations).orderBy(desc(conversations.lastMessageAt)).limit(1))[0]!.id;
const rows = await db.select().from(messages).where(eq(messages.conversationId, conv)).orderBy(asc(messages.createdAt));
for (const m of rows.slice(-14)) {
  const p = (m.payload ?? {}) as any;
  console.log('---', m.createdAt.toISOString().slice(11,19), m.direction, (m.text ?? '').replace(/\n/g,' ').slice(0,160));
  for (const t of p.inspector?.tools ?? []) console.log('    tool:', t.name, t.outcome, 'args:', JSON.stringify(t.args));
  for (const w of p.widgets ?? []) {
    if (w.type !== 'cards') { console.log('    widget:', w.type); continue; }
    console.log('    cards:', (w.items ?? []).map((i: any) => i.title).join(' | '));
  }
}
