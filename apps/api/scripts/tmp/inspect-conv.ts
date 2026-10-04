import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { agents, conversations, messages } from '../../src/db/schema.js';
import { eq, asc } from 'drizzle-orm';
const db = await createDb();
const [conv] = await db.select().from(conversations)
  .where(eq(conversations.id, '1fb291f8-c3f9-422d-bf3d-09766829efb6')).limit(1);
if (!conv) { console.log('not found'); process.exit(1); }
console.log('conv:', conv.id, 'state:', conv.state, 'agent:', conv.agentId,
  'ext:', conv.externalId, 'intent:', conv.intent, 'created:', conv.createdAt.toISOString());
const [agent] = await db.select().from(agents).where(eq(agents.id, conv.agentId)).limit(1);
console.log('agent:', agent?.name, 'hosted:', agent?.hosted,
  'webhook:', Boolean(agent?.webhookUrl), 'engine:', (agent?.config as Record<string,unknown>)?.engine,
  'paused_reply:', (agent?.config as Record<string,unknown>)?.paused);
const msgs = await db.select().from(messages)
  .where(eq(messages.conversationId, conv.id)).orderBy(asc(messages.createdAt));
for (const m of msgs)
  console.log(m.createdAt.toISOString().slice(11,19), m.direction.padEnd(5),
    JSON.stringify(m.payload).slice(0,80), '|', (m.text ?? '').slice(0,100));
process.exit(0);
