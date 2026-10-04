/** Save today's live battery turns as an explicit-turns regression test. */
import { createHash, randomBytes } from 'node:crypto';
import { createDb } from '../../src/db/client.js';
import { messages, sessions, users } from '../../src/db/schema.js';
import { and, asc, eq, gt } from 'drizzle-orm';

const BASE = 'https://janis-api-696050206949.us-east1.run.app';
const AGENT_ID = '13e45248-77e9-4006-b8a5-76c442e522bd';
const CONV_ID = '1fb291f8-c3f9-422d-bf3d-09766829efb6';

const db = await createDb();
const [u] = await db.select().from(users).where(eq(users.email, 'michael.nathanson@gmail.com')).limit(1);

const ms = await db.select().from(messages)
  .where(and(eq(messages.conversationId, CONV_ID), gt(messages.createdAt, new Date('2026-10-03T18:40:00Z'))))
  .orderBy(asc(messages.createdAt));
const turns = ms
  .filter((m) => (m.direction === 'in' || m.direction === 'out') && m.text?.trim())
  .map((m) => ({ role: m.direction === 'in' ? ('customer' as const) : ('agent' as const), text: m.text! }))
  .slice(-60);
console.log('turns:', turns.length, '| first:', turns[0]?.text.slice(0, 50), '| last:', turns.at(-1)?.text.slice(0, 50));

const token = randomBytes(32).toString('hex');
const sid = createHash('sha256').update(token).digest('hex');
await db.insert(sessions).values({ id: sid, userId: u.id, workspaceId: 'acd296f3-61e1-46c5-ae57-6cdbddbdca85', expiresAt: new Date(Date.now() + 30 * 60_000) });
const res = await fetch(`${BASE}/api/agents/${AGENT_ID}/tests`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `janis_session=${token}` },
  body: JSON.stringify({
    name: 'Concierge live battery — tools + link integrity (2026-10-03)',
    expectation:
      'Operator asks the concierge to exercise every connected tool: workspace_stats, account_status, knowledge_gaps, error_reports, debug_conversation, stripe_list_products/prices (with cards widget), stripe_find_customer/customer_charges/customer_subscriptions, plus management actions (teach_agent, create_agent, add_routing_rule, update_agent, update_channel, change_plan, save_widget, teach_from_conversation, assign_conversation). Replies must ground answers in real tool output, park mutating actions as approval cards, link only real console resources, and refuse fake customer ids and unavailable capabilities without fabricating.',
    turns,
  }),
});
console.log('save:', res.status, JSON.stringify(await res.json().catch(() => ({}))).slice(0, 300));
await db.delete(sessions).where(eq(sessions.id, sid));
process.exit(0);
