// One real alert → verify email + push deliver with the corrected sender.
import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { agents, alertRules, conversations, users } from '../../src/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { processEvents } from '../../src/services/ingest.js';
import { fireErrorAlert } from '../../src/lib/ruleAlerts.js';

const AGENT_ID = '13e45248-77e9-4006-b8a5-76c442e522bd';
const db = await createDb();
const [mike] = await db.select().from(users).where(eq(users.email, 'michael.nathanson@gmail.com')).limit(1);
const [agent] = await db.select().from(agents).where(eq(agents.id, AGENT_ID)).limit(1);
if (!mike || !agent) throw new Error('not found');

const [rule] = await db.insert(alertRules).values({
  agentId: agent.id, kind: 'error',
  config: { enabled: true, assign_to: mike.id },
}).returning();

const ext = `matrix-email-${Date.now().toString(36)}`;
await processEvents(db, agent, [{ type: 'message_in', conversation_id: ext, text: 'email path check' }]);
const [conv] = await db.select().from(conversations).where(eq(conversations.externalId, ext)).limit(1);
await fireErrorAlert(db, agent, conv.id, 'inbound.janis.ai email-path check');
await new Promise((r) => setTimeout(r, 4_000));
await db.delete(alertRules).where(eq(alertRules.id, rule.id));
console.log('done — watch for the email');
process.exit(0);
