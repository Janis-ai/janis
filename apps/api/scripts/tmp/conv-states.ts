import { createDb } from '../../src/db/client.js';
import { conversations, alerts } from '../../src/db/schema.js';
import { eq, gt } from 'drizzle-orm';
const db = await createDb();
const convs = await db.select().from(conversations)
  .where(eq(conversations.agentId, '13e45248-77e9-4006-b8a5-76c442e522bd'));
for (const c of convs.filter((x) => (x.lastMessageAt ?? x.createdAt) > new Date('2026-10-03T23:00:00Z'))) {
  const a = await db.select().from(alerts).where(eq(alerts.conversationId, c.id));
  console.log(
    c.id.slice(0, 8), c.state.padEnd(12),
    'assignee:', (c.assigneeId ?? 'none').slice(0, 8),
    'open alerts:', a.filter((x) => x.status === 'open').map((x) => x.type).join(',') || 'none',
    '| ext:', c.externalId.slice(0, 30),
  );
}
process.exit(0);
