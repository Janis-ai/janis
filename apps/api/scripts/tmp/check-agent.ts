import { createDb } from '../../src/db/client.js';
import { agents, channels, messages } from '../../src/db/schema.js';
import { desc, eq, like, sql } from 'drizzle-orm';
const db = await createDb();
const a = await db.select({ id: agents.id, name: agents.name, ws: agents.workspaceId, created: agents.createdAt }).from(agents).where(like(agents.name, '%Smoke%'));
console.log('smoke agents:', a);
// approval cards in the concierge thread
const ms = await db.select().from(messages).where(eq(messages.conversationId, '1fb291f8-c3f9-422d-bf3d-09766829efb6')).orderBy(desc(messages.createdAt)).limit(20);
for (const m of ms) {
  const p = m.payload as { action?: { tool?: string; status?: string; label?: string } };
  if (p.action) console.log(m.createdAt.toISOString(), p.action.tool, p.action.status, '-', p.action.label);
}
process.exit(0);
