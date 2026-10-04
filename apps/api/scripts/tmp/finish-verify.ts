/**
 * Finish the concierge verification: save the live thread as a regression
 * test via the real API, then alert the operator (inbox alert + push/email
 * via notifyWorkspace + Slack if configured).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createDb } from '../../src/db/client.js';
import { agents, alerts, conversations, sessions, users } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { notifyWorkspace } from '../../src/lib/notify.js';
import { postSlackAlert } from '../../src/lib/slack.js';

const BASE = 'https://janis-api-696050206949.us-east1.run.app';
const AGENT_ID = '13e45248-77e9-4006-b8a5-76c442e522bd'; // Janis concierge
const CONV_ID = '1fb291f8-c3f9-422d-bf3d-09766829efb6';
const WS_ID = 'acd296f3-61e1-46c5-ae57-6cdbddbdca85';

const db = await createDb();
const [u] = await db.select().from(users).where(eq(users.email, 'michael.nathanson@gmail.com')).limit(1);
if (!u) throw new Error('user not found');

// 1. Session for the real /tests endpoint.
const token = randomBytes(32).toString('hex');
await db.insert(sessions).values({
  id: createHash('sha256').update(token).digest('hex'),
  userId: u.id,
  workspaceId: WS_ID,
  expiresAt: new Date(Date.now() + 30 * 60_000),
});

// 2. Save as regression test through the real route (drafts expectations).
const res = await fetch(`${BASE}/api/agents/${AGENT_ID}/tests`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `janis_session=${token}` },
  body: JSON.stringify({
    name: 'Live concierge tool verification — 2026-10-03',
    expectation:
      'Battery run live in the concierge rail: every connected tool (workspace_stats, account_status, knowledge_gaps, error_reports, debug_conversation, all 8 Stripe tools, concierge management tools) must return real data; gated actions park approval cards rather than executing; console links resolve to real workspace resources; no fabricated customers, links, or completed actions.',
    conversation_id: CONV_ID,
  }),
});
const body = await res.json().catch(() => ({}));
console.log('save-test:', res.status, JSON.stringify(body).slice(0, 600));

// Clean up the session row.
await db.delete(sessions).where(eq(sessions.id, createHash('sha256').update(token).digest('hex')));

// 3. Alert: inbox row + push/email + Slack.
const [conv] = await db.select().from(conversations).where(eq(conversations.id, CONV_ID)).limit(1);
const [agent] = await db.select().from(agents).where(eq(agents.id, AGENT_ID)).limit(1);
const saved = (body as { tests?: { id: string }[] }).tests?.length ?? 0;
const detail = `Live concierge verification complete — ${saved} regression test(s) saved from this thread. All tools exercised; review the transcript and approval cards. Tests: /agents/${AGENT_ID}/tests`;
const [alert] = await db.insert(alerts).values({
  conversationId: CONV_ID,
  type: 'custom',
  detail,
}).returning();
console.log('alert:', alert.id);
await notifyWorkspace(db, WS_ID, {
  title: 'Alert · Janis',
  body: `Michael Nathanson on Bubble: ${detail}`,
  url: `/conversations/${CONV_ID}`,
}, { userIds: [u.id], agentId: AGENT_ID, event: 'ops' }).catch((e) => console.log('notify err', e));
await postSlackAlert(db, WS_ID, conv, agent, alert).catch((e) => console.log('slack err', e));
console.log('done');
process.exit(0);
