import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { agents, alertRules, alerts, conversations, messages } from '../../src/db/schema.js';
import { and, eq, desc } from 'drizzle-orm';
const db = await createDb();
const convId = process.argv[2]!;
const agentId = process.argv[3]!;
const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
if (!conv) { console.log('conv not found'); process.exit(1); }
console.log('state:', conv.state, '| sentiment:', conv.sentiment, '| agent:', conv.agentId, '| created:', conv.createdAt.toISOString());
const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
console.log('agent:', agent?.name, '| hosted:', agent?.hosted, '| llm cfg:', JSON.stringify((agent?.config as any)?.llm ?? null).slice(0, 200));
const rules = await db.select().from(alertRules).where(eq(alertRules.agentId, agentId));
for (const r of rules) console.log('rule:', r.kind, JSON.stringify(r.config).slice(0, 200));
const convAlerts = await db.select().from(alerts).where(eq(alerts.conversationId, convId));
console.log('alerts on conv:', convAlerts.length ? convAlerts.map((a) => `${a.type}/${a.status}`).join(', ') : 'none');
const rows = await db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(desc(messages.createdAt)).limit(12);
for (const m of rows.reverse())
  console.log(m.createdAt.toISOString().slice(11, 19), m.direction.padEnd(5), JSON.stringify(m.payload).slice(0, 80), '|', (m.text ?? '').slice(0, 80));
process.exit(0);
