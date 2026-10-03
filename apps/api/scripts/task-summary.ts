/**
 * End-of-task summary ritual (see AGENTS.md): emails a summary from
 * janis@inbound.janis.ai and fires a 'custom' alert on the concierge rail
 * conversation so it lands in the Janis Inbox, as a push/email via member
 * prefs, and on the workspace's Slack alert channel.
 *
 * Usage (from apps/api, with prod env loaded):
 *   export DATABASE_URL=… RESEND_API_KEY=…
 *   npx tsx scripts/task-summary.ts "Task title" "Body text. Links allowed."
 */
import { createDb } from '../src/db/client.js';
import { agents, alerts, conversations, users } from '../src/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { notifyWorkspace } from '../src/lib/notify.js';
import { postSlackAlert } from '../src/lib/slack.js';
import { env } from '../src/env.js';

const AGENT_ID = '13e45248-77e9-4006-b8a5-76c442e522bd'; // concierge (Michael's workspace)
const CONV_ID = '1fb291f8-c3f9-422d-bf3d-09766829efb6'; // operator rail thread
const WS_ID = 'acd296f3-61e1-46c5-ae57-6cdbddbdca85';
const TO = 'michael.nathanson@gmail.com';
const FROM = 'Janis <janis@inbound.janis.ai>';

const [title, ...rest] = process.argv.slice(2);
const body = rest.join(' ') || title;
if (!title) {
  console.error('usage: task-summary.ts "Title" "Body"');
  process.exit(1);
}

const db = await createDb();
const [u] = await db.select().from(users).where(eq(users.email, TO)).limit(1);
const [conv] = await db.select().from(conversations).where(eq(conversations.id, CONV_ID)).limit(1);
const [agent] = await db.select().from(agents).where(eq(agents.id, AGENT_ID)).limit(1);
if (!u || !conv || !agent) throw new Error('user/conv/agent lookup failed');

// 1. Email summary.
const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${env.resendApiKey}` },
  body: JSON.stringify({
    from: FROM,
    to: [TO],
    subject: `Janis task: ${title}`,
    text: body,
  }),
});
console.log('email:', res.status, res.ok ? (await res.json() as {id:string}).id : await res.text());

// 2. Inbox alert row + push + Slack. One open alert per (conv, type) — the
// ritual reuses 'custom', so refresh the open row instead of colliding.
const detail = `${title} — ${body}`;
const [existing] = await db
  .select()
  .from(alerts)
  .where(and(eq(alerts.conversationId, CONV_ID), eq(alerts.type, 'custom'), eq(alerts.status, 'open')))
  .limit(1);
const [alert] = existing
  ? await db
      .update(alerts)
      .set({ detail, createdAt: new Date() })
      .where(eq(alerts.id, existing.id))
      .returning()
  : await db
      .insert(alerts)
      .values({ conversationId: CONV_ID, type: 'custom', detail })
      .returning();
await notifyWorkspace(
  db,
  WS_ID,
  { title: `Alert · ${agent.name}`, body: `${u.name}: ${title} — ${body}`, url: `/conversations/${CONV_ID}` },
  { userIds: [u.id], agentId: AGENT_ID, event: 'ops' },
).catch((e) => console.error('notify:', e));
await postSlackAlert(db, WS_ID, conv, agent, alert).catch((e) => console.error('slack:', e));
console.log('alert:', alert.id, '— inbox + push + slack dispatched');
process.exit(0);
