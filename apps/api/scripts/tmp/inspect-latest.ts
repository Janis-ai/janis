import { createDb } from '../../src/db/client.js';
import { messages, conversations } from '../../src/db/schema.js';
import { eq, desc, and } from 'drizzle-orm';
const db = await createDb();
const convs = await db.select().from(conversations)
  .where(eq(conversations.agentId, 'd408d7b5-fdad-49a4-a34d-11fa16e88135'))
  .orderBy(desc(conversations.lastMessageAt)).limit(6);
for (const c of convs) {
  console.log('\n### conv', c.id.slice(0,8), '|', c.externalId);
  const msgs = await db.select().from(messages)
    .where(and(eq(messages.conversationId, c.id), eq(messages.direction, 'out')))
    .orderBy(desc(messages.createdAt)).limit(2);
  for (const m of msgs) {
    const p = (m.payload ?? {}) as Record<string, unknown>;
    console.log(' ', m.createdAt?.toISOString(), '|', (m.text ?? '').slice(0, 60));
    console.log('    keys:', Object.keys(p).join(',') || '(none)');
    if (p.widgets) console.log('    widgets:', JSON.stringify(p.widgets).slice(0, 300));
  }
}
process.exit(0);
