import { createDb } from '../../src/db/client.js';
import { conversations, messages, agents } from '../../src/db/schema.js';
import { desc, eq } from 'drizzle-orm';
const db = await createDb();
const convs = await db.select().from(conversations).where(eq(conversations.agentId, '13e45248-77e9-4006-b8a5-76c442e522bd')).orderBy(desc(conversations.lastMessageAt)).limit(5);
for (const c of convs) console.log(c.id, '| ext:', c.externalId, '| state:', c.state, '| last:', c.lastMessageAt?.toISOString(), '|', (c.lastMessagePreview ?? '').slice(0, 60));
const latest = convs[0];
if (latest) {
  const ms = await db.select().from(messages).where(eq(messages.conversationId, latest.id)).orderBy(desc(messages.createdAt)).limit(8);
  for (const m of ms.reverse()) console.log(' ', m.direction, m.createdAt.toISOString(), JSON.stringify(m.text ?? '').slice(0, 100), Object.keys(m.payload as object).join(','));
}
process.exit(0);
