import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { eq, desc } from 'drizzle-orm';
import { agents, conversations, messages } from '../../src/db/schema.js';
import { runHostedEvent } from '../../src/lib/hostedAgent.js';
const db = await createDb();
const convId = process.argv[2] ?? '1fb291f8-c3f9-422d-bf3d-09766829efb6';
const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
if (!conv) throw new Error('conv not found');
const [agent] = await db.select().from(agents).where(eq(agents.id, conv.agentId)).limit(1);
const [lastIn] = await db
  .select()
  .from(messages)
  .where(eq(messages.conversationId, convId))
  .orderBy(desc(messages.createdAt))
  .limit(10)
  .then((rows) => rows.filter((r) => r.direction === 'in'));
console.log('replaying inbound:', JSON.stringify(lastIn?.text), 'state:', conv.state);
await runHostedEvent(db, agent, {
  type: 'message.user',
  timestamp: new Date().toISOString(),
  conversation_id: conv.externalId,
  janis_conversation_id: conv.id,
  text: lastIn?.text ?? '',
} as never);
console.log('runHostedEvent returned');
process.exit(0);
