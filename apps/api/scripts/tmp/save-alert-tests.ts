/** Save regression tests from the alert-matrix live probes. */
import { createHash, randomBytes } from 'node:crypto';
import { createDb } from '../../src/db/client.js';
import { conversations, messages, sessions, users } from '../../src/db/schema.js';
import { and, asc, eq } from 'drizzle-orm';

const BASE = 'https://janis-api-696050206949.us-east1.run.app';
const AGENT_ID = '13e45248-77e9-4006-b8a5-76c442e522bd';
const db = await createDb();
const [u] = await db.select().from(users).where(eq(users.email, 'michael.nathanson@gmail.com')).limit(1);
const token = randomBytes(32).toString('hex');
const sid = createHash('sha256').update(token).digest('hex');
await db.insert(sessions).values({
  id: sid, userId: u.id,
  workspaceId: 'acd296f3-61e1-46c5-ae57-6cdbddbdca85',
  expiresAt: new Date(Date.now() + 30 * 60_000),
});
const save = async (name: string, expectation: string, turns: unknown) => {
  const res = await fetch(`${BASE}/api/agents/${AGENT_ID}/tests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `janis_session=${token}` },
    body: JSON.stringify({ name, expectation, turns }),
  });
  console.log(name.slice(0, 60), '→', res.status, JSON.stringify(await res.json().catch(() => ({}))).slice(0, 160));
};

// 1. intent miss — claimed no Stripe access despite holding the tools
await save(
  'Alert battery — billing question must try Stripe tools (intent miss)',
  'Customer with a verified identity asks "when does my Janis invoice renew? I think I was double billed." The concierge MUST attempt stripe_find_customer and/or stripe_customer_charges before disclaiming — it must NOT claim "I don\'t have access to Stripe billing history" when the tools are connected and the visitor is verified. Observed 2026-10-03: it claimed no access without calling any tool.',
  [
    { role: 'customer', text: 'when does my Janis invoice renew? I think I was double billed.' },
    { role: 'agent', text: 'I see your account is associated with three different workspaces. Since I don\'t have direct access to your Stripe billing history to verify specific charges, I recommend checking the billing page.' },
  ],
);

// 2. positive — explicit human request escalates cleanly (conv C b201fc51…)
const convRows = await db.select().from(conversations).where(eq(conversations.agentId, AGENT_ID));
const cConv = convRows.find((c) => c.id.startsWith('b201fc51'))!;
const ms = await db.select().from(messages)
  .where(eq(messages.conversationId, cConv.id)).orderBy(asc(messages.createdAt)).limit(6);
const turns = ms
  .filter((m) => m.text?.trim() && m.direction !== 'internal')
  .map((m) => ({ role: m.direction === 'in' ? 'customer' : 'agent', text: m.text }));
console.log('conv C turns:', turns.length, cConv.id);
await save(
  'Alert battery — explicit human request escalates (positive)',
  'Customer\'s first message asks to speak to a human. The agent must emit the handoff escalation (needs_human + help_request alert) and tell the customer a human is being notified — not keep deflecting with self-help.',
  turns,
);

await db.delete(sessions).where(eq(sessions.id, sid));
process.exit(0);
