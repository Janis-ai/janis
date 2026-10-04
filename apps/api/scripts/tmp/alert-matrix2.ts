/**
 * Alert matrix round 2 — the remaining kinds that need isolated state:
 * intent + sentiment (opener-only classification), handoff_request (needs
 * an 'active' conv so [HANDOFF] really fires), custom (resolve the open
 * dedupe-blocker first), inactivity (needs an unanswered last inbound).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createDb } from '../../src/db/client.js';
import {
  agents, alertRules, alerts, channels, conversations, messages, users,
} from '../../src/db/schema.js';
import { and, desc, eq } from 'drizzle-orm';
import { sha256 } from '../../src/lib/crypto.js';

const BASE = 'https://janis-api-696050206949.us-east1.run.app';
const RAIL = '7595ffbd-6b87-47ef-8b97-9228eb28042c';
const CONV = '1fb291f8-c3f9-422d-bf3d-09766829efb6';
const AGENT = '13e45248-77e9-4006-b8a5-76c442e522bd';
const db = await createDb();
const [ch] = await db.select().from(channels).where(eq(channels.id, RAIL)).limit(1);
const [u] = await db.select().from(users).where(eq(users.email, 'michael.nathanson@gmail.com')).limit(1);
const log = (s: string) => console.log(s);
const t0 = new Date();

const seeded = await db.insert(alertRules).values([
  { agentId: AGENT, kind: 'intent', config: { enabled: true, intents: ['billing'], assign_to: u.id } },
  { agentId: AGENT, kind: 'sentiment', config: { enabled: true, assign_to: u.id } },
  { agentId: AGENT, kind: 'inactivity', config: { enabled: true, inactivity_minutes: 1, assign_to: u.id } },
  { agentId: AGENT, kind: 'custom_alert', config: { enabled: true, assign_to: u.id } },
  { agentId: AGENT, kind: 'handoff_request', config: { enabled: true, assign_to: u.id } },
]).returning();
log(`seeded ${seeded.length} rules`);

// resolve the open 'custom' alert so a fresh one can land
await db.update(alerts).set({ status: 'resolved', resolvedAt: new Date() })
  .where(and(eq(alerts.conversationId, CONV), eq(alerts.type, 'custom'), eq(alerts.status, 'open')));

const post = (text: string, vis: string) =>
  fetch(`${BASE}/chat/${RAIL}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitor_id: vis, text }),
  });
const convFor = (vis: string) =>
  db.select().from(conversations)
    .where(and(eq(conversations.agentId, AGENT), eq(conversations.externalId, `webchat:${vis}`))).limit(1);
const lastOut = async (convId: string, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs;
  const start = new Date();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3500));
    const [m] = await db.select().from(messages)
      .where(and(eq(messages.conversationId, convId), eq(messages.direction, 'out')))
      .orderBy(desc(messages.createdAt)).limit(1);
    if (m && m.createdAt > start) return m;
  }
  return undefined;
};

// A: billing opener → intent alert
const vA = randomBytes(16).toString('hex');
await post('Hi — I think I was double billed on my Janis invoice. When does it renew?', vA);
const [convA] = await convFor(vA);
const mA = await lastOut(convA.id);
log(`[intent] conv ${convA.id.slice(0, 8)} reply: ${(mA?.text ?? 'TIMEOUT').slice(0, 140).replace(/\n/g, ' ')}`);

// B: angry opener → sentiment alert
const vB = randomBytes(16).toString('hex');
await post("I'm absolutely furious — this product is broken garbage and a total waste of money.", vB);
const [convB] = await convFor(vB);
const mB = await lastOut(convB.id);
log(`[sentiment] conv ${convB.id.slice(0, 8)} reply: ${(mB?.text ?? 'TIMEOUT').slice(0, 140).replace(/\n/g, ' ')}`);

// C: human-request opener → [HANDOFF] → help_request
const vC = randomBytes(16).toString('hex');
await post('I want to speak to a human agent right now please.', vC);
const [convC] = await convFor(vC);
const mC = await lastOut(convC.id);
log(`[handoff] conv ${convC.id.slice(0, 8)} reply: ${(mC?.text ?? 'TIMEOUT').slice(0, 140).replace(/\n/g, ' ')}`);
const [cState] = await db.select({ state: conversations.state }).from(conversations).where(eq(conversations.id, convC.id)).limit(1);
log(`[handoff] convC state=${cState.state}`);

// custom_alert via /v1 on the rail conv (open dedupe-blocker resolved above)
const [agentRow] = await db.select().from(agents).where(eq(agents.id, AGENT)).limit(1);
const tmpKey = `jk_test_${randomBytes(24).toString('hex')}`;
await db.update(agents).set({ apiKeyHash: sha256(tmpKey) }).where(eq(agents.id, AGENT));
const [convRow] = await db.select().from(conversations).where(eq(conversations.id, CONV)).limit(1);
const res = await fetch(`${BASE}/v1/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tmpKey}` },
  body: JSON.stringify({ events: [{ type: 'custom_alert', conversation_id: convRow.externalId, alert_type: 'test-custom-2', text: 'round-2 custom alert' }] }),
});
log(`[custom] v1 POST ${res.status}`);
await db.update(agents).set({ apiKeyHash: agentRow.apiKeyHash }).where(eq(agents.id, AGENT));

// inactivity — plant an unanswered inbound on conv A
await db.insert(messages).values({ conversationId: convA.id, direction: 'in', text: 'hello? anyone there?' });
await db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, convA.id));
log('[inactivity] planted unanswered inbound on conv A; waiting ~150s for sweeper');
await new Promise((r) => setTimeout(r, 150_000));

// report
for (const [label, cid] of [['rail', CONV], ['A', convA.id], ['B', convB.id], ['C', convC.id]] as const) {
  const rows = await db.select().from(alerts)
    .where(and(eq(alerts.conversationId, cid))).orderBy(desc(alerts.createdAt)).limit(6);
  for (const a of rows.filter((a) => a.createdAt > t0))
    log(`  conv:${label} ${a.type.padEnd(14)} ${a.status} ${(a.detail ?? '').slice(0, 100)}`);
}
for (const r of seeded) await db.delete(alertRules).where(eq(alertRules.id, r.id));
log('cleanup: test rules deleted');
process.exit(0);
