import { createDb } from '../../src/db/client.js';
import { conversations, messages } from '../../src/db/schema.js';
import { desc, eq, like, and } from 'drizzle-orm';

const db = await createDb();
const [conv] = await db.select({ id: conversations.id }).from(conversations)
  .where(eq(conversations.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'))
  .orderBy(desc(conversations.createdAt)).limit(1);
const msgs = await db.select({ id: messages.id, text: messages.text, payload: messages.payload, createdAt: messages.createdAt })
  .from(messages).where(and(eq(messages.conversationId, conv.id), like(messages.text, '%currently have%')))
  .orderBy(desc(messages.createdAt)).limit(3);
for (const m of msgs) {
  console.log('---', m.createdAt, m.text.slice(0, 80));
  const ws = (m.payload as { widgets?: unknown[] })?.widgets;
  for (const w of ws ?? []) {
    const ww = w as { type: string; items?: { title?: string; image?: string }[] };
    if (ww.type === 'cards')
      for (const i of ww.items ?? []) console.log(`  card: ${i.title} | image=${JSON.stringify(i.image)}`);
  }
}
process.exit(0);
