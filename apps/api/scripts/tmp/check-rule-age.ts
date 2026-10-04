import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { alertRules, alerts, conversations } from '../../src/db/schema.js';
import { desc, eq, inArray } from 'drizzle-orm';
const db = await createDb();
const agentId = '7b90d58b-2253-495e-bc61-a575bf958c5b';
const rules = await db.select().from(alertRules).where(eq(alertRules.agentId, agentId));
for (const r of rules) console.log(r.kind, '| created:', r.createdAt.toISOString(), '| config:', JSON.stringify(r.config).slice(0, 150));
const convRows = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.agentId, agentId));
const convIds = convRows.map((c) => c.id);
const mine = convIds.length
  ? await db.select().from(alerts).where(inArray(alerts.conversationId, convIds)).orderBy(desc(alerts.createdAt)).limit(20)
  : [];
console.log('alerts on this agent (recent):', mine.length ? mine.map((a) => `${a.type}/${a.status}@${a.createdAt.toISOString().slice(11,19)}`).join(', ') : 'NONE');
process.exit(0);
