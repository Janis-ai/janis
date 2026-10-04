/**
 * Alert-matrix live test — seeds one rule of every kind on the concierge
 * agent, triggers each through its real code path (rail messages, v1 events
 * via a temporary api key, csat capture, fresh-conversation auto-assign,
 * inactivity sweep), then reports which alert rows actually fired.
 * Restores the api key hash and removes the test rules afterward.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createDb } from '../../src/db/client.js';
import {
  agents,
  alertRules,
  alerts,
  channels,
  conversations,
  messages,
  users,
} from '../../src/db/schema.js';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { sha256 } from '../../src/lib/crypto.js';

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
const log = (s: string) => console.log(s);

const alertT0 = new Date();
async function alertsSince() {
  return db.select().from(alerts).where(and(eq(alerts.conversationId, CONV), gt(alerts.createdAt, alertT0)));
}

// ── 1. seed one rule per kind ─────────────────────────────────────────
const seeded = await db.insert(alertRules).values([
  { agentId: AGENT, kind: 'keyword', config: { enabled: true, keywords: ['zebracorn'], tag: 'alrttest-kw', assign_to: u.id } },
  { agentId: AGENT, kind: 'intent', config: { enabled: true, intents: ['billing'], tag: 'alrttest-intent', assign_to: u.id } },
  { agentId: AGENT, kind: 'sentiment', config: { enabled: true, tag: 'alrttest-sent', assign_to: u.id } },
  { agentId: AGENT, kind: 'error', config: { enabled: true, tag: 'alrttest-err', assign_to: u.id } },
  { agentId: AGENT, kind: 'csat', config: { enabled: true, max_score: 3, tag: 'alrttest-csat', assign_to: u.id } },
  { agentId: AGENT, kind: 'inactivity', config: { enabled: true, inactivity_minutes: 1, tag: 'alrttest-inact', assign_to: u.id } },
  { agentId: AGENT, kind: 'custom_alert', config: { enabled: true, tag: 'alrttest-custom', assign_to: u.id } },
  { agentId: AGENT, kind: 'failure', config: { enabled: true, tag: 'alrttest-fail', assign_to: u.id } },
  { agentId: AGENT, kind: 'handoff_request', config: { enabled: true, tag: 'alrttest-handoff', assign_to: u.id } },
  { agentId: AGENT, kind: 'auto_assign', config: { enabled: true, assign_to: u.id } },
]).returning();
log(`seeded ${seeded.length} rules`);

// ── 2. temp api key for /v1/events + 1min SLA on the agent config ─────
const [agentRow] = await db.select().from(agents).where(eq(agents.id, AGENT)).limit(1);
const oldHash = agentRow.apiKeyHash;
const oldConfig = agentRow.config;
const tmpKey = `jk_test_${randomBytes(24).toString('hex')}`;
await db.update(agents).set({
  apiKeyHash: sha256(tmpKey),
  config: { ...(oldConfig as object), sla_minutes: 1 },
}).where(eq(agents.id, AGENT));

const post = (text: string, extra: Record<string, unknown> = {}, vis = visitor, useClaim = true) =>
  fetch(`${BASE}/chat/${RAIL}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitor_id: vis, ...(useClaim ? { user: claim } : {}), text, ...extra }),
  });
const seen = new Set<string>(
  (await db.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, CONV))).map((m) => m.id),
);
async function waitReply(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3500));
    const rows = await db.select().from(messages)
      .where(and(eq(messages.conversationId, CONV), eq(messages.direction, 'out')))
      .orderBy(desc(messages.createdAt)).limit(3);
    const fresh = rows.find((m) => !seen.has(m.id));
    if (fresh) { rows.forEach((m) => seen.add(m.id)); return fresh; }
  }
  return undefined;
}
async function probe(label: string, text: string) {
  await post(text);
  const m = await waitReply();
  log(`[${label}] ${(m?.text ?? 'TIMEOUT').slice(0, 170).replace(/\n/g, ' ')}`);
  await new Promise((r) => setTimeout(r, 2500)); // let async side-effects (alerts) land
}

// ── 3. rail message triggers ──────────────────────────────────────────
await probe('keyword', 'zebracorn — testing the keyword alert rule');
await probe('intent(billing)', 'when does my Janis invoice renew? I think I was double billed.');
await probe('sentiment', "I'm furious — nothing in this product works and this is a complete waste of money.");
await probe('error', 'Look up the Stripe charges for customer cus_FAKE123XYZ please.');

// ── 4. csat — force pending, then rate low ────────────────────────────
await db.update(conversations).set({ csatPending: true }).where(eq(conversations.id, CONV));
await post('1');
await new Promise((r) => setTimeout(r, 5000));
log('[csat] sent rating 1 with csatPending forced');

// ── 5. v1 events: custom_alert + failure ──────────────────────────────
const [convRow] = await db.select().from(conversations).where(eq(conversations.id, CONV)).limit(1);
for (const ev of [
  { type: 'custom_alert', conversation_id: convRow.externalId, alert_type: 'test-custom', text: 'test custom alert via v1' },
  { type: 'failure', conversation_id: convRow.externalId, reason: 'test failure via v1' },
]) {
  const res = await fetch(`${BASE}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tmpKey}` },
    body: JSON.stringify({ events: [ev] }),
  });
  log(`[v1 ${ev.type}] POST ${res.status} ${(await res.text()).slice(0, 100)}`);
}
await new Promise((r) => setTimeout(r, 4000));

// ── 6. auto_assign — fresh anonymous visitor on the rail channel ──────
const freshV = randomBytes(16).toString('hex');
await post('hello, is anyone there?', {}, freshV, false);
await new Promise((r) => setTimeout(r, 5000));
const [freshConv] = await db.select().from(conversations)
  .where(and(eq(conversations.agentId, AGENT), eq(conversations.externalId, `webchat:${freshV}`))).limit(1);
log(`[auto_assign] fresh conv ${freshConv?.id} assignee=${freshConv?.assigneeId} (want ${u.id})`);

// ── 7. handoff → needs_human, then an unanswered inbound so the
// inactivity sweep has a waiting customer; SLA re-alert targets the
// same unclaimed needs_human thread (sla_minutes=1 set above) ──────────
await probe('handoff', 'I want to talk to a human right now.');
await post('are you still there?');
await new Promise((r) => setTimeout(r, 5000));
log('[handoff] conv should be needs_human; final inbound left unanswered');
log('[inactivity+sla] waiting ~140s for sweeper…');
await new Promise((r) => setTimeout(r, 140_000));

// ── 8. report + cleanup ───────────────────────────────────────────────
const fired = await alertsSince();
log(`\n=== alerts created since ${alertT0.toISOString()} ===`);
for (const a of fired) log(`  ${a.type.padEnd(14)} ${(a.detail ?? '').slice(0, 120)}`);
// alerts on the fresh anon conv too
if (freshConv) {
  const fa = await db.select().from(alerts).where(and(eq(alerts.conversationId, freshConv.id), gt(alerts.createdAt, alertT0)));
  for (const a of fa) log(`  ${a.type.padEnd(14)} ${(a.detail ?? '').slice(0, 120)}  (anon conv)`);
}

// restore key + config, drop only the test rules
await db.update(agents).set({ apiKeyHash: oldHash, config: oldConfig }).where(eq(agents.id, AGENT));
await db.delete(alertRules).where(eq(alertRules.id, seeded.map((r) => r.id)[0]));
for (const r of seeded.slice(1)) await db.delete(alertRules).where(eq(alertRules.id, r.id));
log(`cleanup: restored api key hash, deleted ${seeded.length} test rules`);
const [finalConv] = await db.select().from(conversations).where(eq(conversations.id, CONV)).limit(1);
log(`final conv state=${finalConv.state}`);
process.exit(0);
