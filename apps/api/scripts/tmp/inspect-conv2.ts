import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { agents, conversations } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
const db = await createDb();
const [conv] = await db.select().from(conversations)
  .where(eq(conversations.id, '1fb291f8-c3f9-422d-bf3d-09766829efb6')).limit(1);
console.log('state:', conv.state, '| paused:', conv.pauseMinutes, '| snoozed:', conv.snoozedUntil,
  '| humanSince:', conv.humanSince, '| assignee:', conv.assigneeId, '| csatPending:', conv.csatPending);
const [agent] = await db.select().from(agents).where(eq(agents.id, conv.agentId)).limit(1);
console.log('agent:', agent?.name, '| hosted:', agent?.hosted, '| webhook:', agent?.webhookUrl ? 'set' : null);
const cfg = (agent?.config ?? {}) as Record<string, unknown>;
console.log('config keys:', Object.keys(cfg).join(','), '| engine:', cfg.engine, '| paused:', cfg.paused);
process.exit(0);
