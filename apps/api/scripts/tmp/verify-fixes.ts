/** Live verify the alert fixes: mid-thread sentiment fires per-inbound,
 *  keyword alerts notify without seizing the thread into needs_human. */
import { createHmac, randomBytes } from 'node:crypto';
import { createDb } from '../../src/db/client.js';
import { alertRules, alerts, channels, conversations, messages, users } from '../../src/db/schema.js';
import { and, desc, eq, gt } from 'drizzle-orm';

const BASE = 'https://janis-api-696050206949.us-east1.run.app';
const RAIL = '7595ffbd-6b87-47ef-8b97-9228eb28042c';
const CONV = '1fb291f8-c3f9-422d-bf3d-09766829efb6';
const AGENT = '13e45248-77e9-4006-b8a5-76c442e522bd';
const db = await createDb();
const [ch] = await db.select().from(channels).where(eq(channels.id, RAIL)).limit(1);
const [u] = await db.select().from(users).where(eq(users.email, 'michael.nathanson@gmail.com')).limit(1);
const sig = createHmac('sha256', (ch.credentials as { identity_secret: string }).identity_secret)
  .update(`${u.id}|${u.email}|${u.name ?? ''}`).digest('hex');
const claim = { id: u.id, name: u.name, email: u.email, sig };
const visitor = randomBytes(16).toString('hex');
const t0 = new Date();
const log = console.log;

const seeded = await db.insert(alertRules).values([
  { agentId: AGENT, kind: 'sentiment', config: { enabled: true, assign_to: u.id } },
  { agentId: AGENT, kind: 'keyword', config: { enabled: true, keywords: ['zebracorn2'], assign_to: u.id } },
]).returning();

// 1. mid-thread sentiment on the long-lived rail conv
await fetch(`${BASE}/chat/${RAIL}/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ visitor_id: visitor, user: claim, text: 'I am extremely angry — this is the worst experience I have ever had.' }),
});
log('sent angry mid-thread message on rail conv');

// 2. keyword on a FRESH anon conv — state must stay 'active' now
const vK = randomBytes(16).toString('hex');
await fetch(`${BASE}/chat/${RAIL}/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ visitor_id: vK, text: 'zebracorn2 — keyword test, do not escalate' }),
});
log('sent keyword message on fresh conv');

await new Promise((r) => setTimeout(r, 30_000));

const sent = await db.select().from(alerts)
  .where(and(eq(alerts.conversationId, CONV), eq(alerts.type, 'sentiment'), gt(alerts.createdAt, t0)));
log(`mid-thread sentiment alerts: ${sent.length}${sent[0] ? ` — "${sent[0].detail}"` : ''}`);

const convs = await db.select().from(conversations).where(eq(conversations.agentId, AGENT));
const convK = convs.find((c) => c.externalId === `webchat:${vK}`)!;
const kw = await db.select().from(alerts)
  .where(and(eq(alerts.conversationId, convK.id), eq(alerts.type, 'keyword'), gt(alerts.createdAt, t0)));
log(`keyword alerts on fresh conv: ${kw.length} | conv state: ${convK.state} (want 'active')`);

for (const r of seeded) await db.delete(alertRules).where(eq(alertRules.id, r.id));
log('cleanup done');
process.exit(0);
