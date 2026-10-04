// Full alert matrix — one real trigger per alert type against the concierge
// agent, end-to-end through the production code paths. Signs Mike up for
// every notification bucket first, then verifies an open alert row per type.
// Run: DATABASE_URL="$(grep '^DATABASE_URL' .env.production | cut -d= -f2-)" \
//   npx tsx scripts/tmp/alert-full-matrix.ts
import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import {
  agentMembers,
  agents,
  alertRules,
  alerts,
  conversations,
  users,
} from '../../src/db/schema.js';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { processEvents } from '../../src/services/ingest.js';
import { sweep, sweepSla } from '../../src/services/sweeper.js';
import { fireErrorAlert } from '../../src/lib/ruleAlerts.js';
import { requestToolApproval } from '../../src/lib/approvals.js';
import { captureCsat } from '../../src/lib/csat.js';
import type { ToolDef } from '../../src/lib/toolExec.js';

const AGENT_ID = '13e45248-77e9-4006-b8a5-76c442e522bd'; // concierge
const MIKE_EMAIL = 'michael.nathanson@gmail.com';
const STAMP = Date.now().toString(36);
const ext = (slug: string) => `matrix-${slug}-${STAMP}`;

const db = await createDb();

const [mike] = await db.select().from(users).where(eq(users.email, MIKE_EMAIL)).limit(1);
if (!mike) throw new Error('mike not found');
const [agent] = await db.select().from(agents).where(eq(agents.id, AGENT_ID)).limit(1);
if (!agent) throw new Error('concierge not found');
console.log(`user=${mike.id} agent=${agent.name} ws=${agent.workspaceId}`);

// ── 1. subscribe Mike to every alert bucket, globally + on this agent ────────
const allEvents = {
  handoff: true, offer: true, assigned: true, keyword: true, intent: true,
  sentiment: true, csat: true, inactivity: true, sla: true, custom: true,
  failure: true, mention: true, digest: true, approval: true, eval: true, ops: true,
};
await db.update(users)
  .set({ notifyPrefs: { push: true, email: true, sound: true, events: allEvents } })
  .where(eq(users.id, mike.id));
const [membership] = await db
  .select()
  .from(agentMembers)
  .where(and(eq(agentMembers.agentId, agent.id), eq(agentMembers.userId, mike.id)))
  .limit(1);
if (membership) {
  await db.update(agentMembers)
    .set({ notifyPrefs: { push: true, email: true, sound: true, events: allEvents } })
    .where(eq(agentMembers.id, membership.id));
  console.log('agent_members override set');
}
console.log('notify prefs: all 16 events on, push+email+sound on');

// ── 2. seed one enabled rule per kind, all routed to Mike ────────────────────
const RULES: { kind: string; config: Record<string, unknown> }[] = [
  { kind: 'keyword', config: { enabled: true, keywords: ['matrixkeyword'], assign_to: mike.id } },
  { kind: 'intent', config: { enabled: true, intents: ['matrix_topic'], assign_to: mike.id } },
  { kind: 'failure', config: { enabled: true, assign_to: mike.id } },
  { kind: 'handoff_request', config: { enabled: true, assign_to: mike.id } },
  { kind: 'inactivity', config: { enabled: true, inactivity_minutes: 1, assign_to: mike.id } },
  { kind: 'custom_alert', config: { enabled: true, assign_to: mike.id } },
  { kind: 'sentiment', config: { enabled: true, assign_to: mike.id } },
  { kind: 'error', config: { enabled: true, assign_to: mike.id } },
  { kind: 'csat', config: { enabled: true, max_score: 3, assign_to: mike.id } },
];
const ruleIds: string[] = [];
for (const r of RULES) {
  const [row] = await db
    .insert(alertRules)
    .values({ agentId: agent.id, kind: r.kind as never, config: r.config })
    .returning();
  ruleIds.push(row.id);
}
// SLA isn't a rule — it rides the agent config
const origConfig = (agent.config ?? {}) as Record<string, unknown>;
await db.update(agents).set({ config: { ...origConfig, sla_minutes: 1 } }).where(eq(agents.id, agent.id));
console.log(`seeded ${ruleIds.length} rules + sla_minutes=1`);

async function convFor(slug: string) {
  const [c] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.externalId, ext(slug)))
    .limit(1);
  return c!;
}
async function ingest(slug: string, events: Parameters<typeof processEvents>[2]) {
  await processEvents(db, agent, events.map((e) => ({ ...e, conversation_id: ext(slug) })) as never);
}

const expect: Record<string, string> = {}; // slug -> alert type

// ── 3. fire every trigger ────────────────────────────────────────────────────
// keyword — plain message_in containing the rule phrase
await ingest('keyword', [{ type: 'message_in', text: 'this message has matrixkeyword inside' }]);
expect.keyword = 'keyword';

// intent — payload-stamped intent skips the LLM and still runs rule matching
await ingest('intent', [{ type: 'message_in', text: 'hi', payload: { intent: 'matrix_topic' } }]);
expect.intent = 'intent';

// sentiment — a clearly negative inbound; the classify call is async
await ingest('sentiment', [
  { type: 'message_in', text: 'I am absolutely furious — this is the worst service I have ever used' },
]);
expect.sentiment = 'sentiment';

// failure — the agent reports it couldn't handle something
await ingest('failure', [{ type: 'failure', reason: 'matrix test failure' }]);
expect.failure = 'failure';

// help_request — explicit handoff
await ingest('help', [{ type: 'handoff_request', reason: 'customer asked for a human' }]);
expect.help = 'help_request';

// handoff_offer — offer without acceptance (dedicated conv so no later
// message_in marks it stale)
await ingest('offer', [{ type: 'handoff_offer', reason: 'would you like a human?' }]);
expect.offer = 'handoff_offer';

// custom — agent-defined alert
await ingest('custom', [{ type: 'custom_alert', alert_type: 'matrix_custom_signal' }]);
expect.custom = 'custom';

// error — run-degradation alert via the shared lib path
await ingest('error', [{ type: 'message_in', text: 'hi for error conv' }]);
await fireErrorAlert(db, agent, (await convFor('error')).id, 'matrix test run error');
expect.error = 'error';

// approval_request — a gated tool parks awaiting a decision
await ingest('approval', [{ type: 'message_in', text: 'refund order o-42 please' }]);
const GATED: ToolDef = {
  name: 'refund_order', description: 'refund it', method: 'POST', approval: true,
  url: 'http://localhost:9/api/refund', params: { order_id: 'id' },
};
await requestToolApproval(db, agent, (await convFor('approval')).id, GATED, { order_id: 'o-42' });
expect.approval = 'approval_request';

// csat — pending survey + a low rating reply
await ingest('csat', [{ type: 'message_in', text: 'hello csat conv' }]);
{
  const conv = await convFor('csat');
  await db.update(conversations).set({ csatPending: true }).where(eq(conversations.id, conv.id));
  await captureCsat(db, { ...conv, csatPending: true }, '2');
}
expect.csat = 'csat';

// inactivity — fresh conv awaiting agent reply, backdate past the 1m
// threshold, run the sweeper's inactivity pass directly
await ingest('inact', [{ type: 'message_in', text: 'anyone there?' }]);
{
  const conv = await convFor('inact');
  await db.update(conversations)
    .set({ lastMessageDirection: 'in', lastMessageAt: new Date(Date.now() - 120_000) })
    .where(eq(conversations.id, conv.id));
}
expect.inact = 'inactivity';

// sla — a needs_human conv whose anchor alert is older than the 1m SLA
await ingest('sla', [{ type: 'handoff_request', reason: 'sla seed handoff' }]);
{
  const conv = await convFor('sla');
  const past = new Date(Date.now() - 120_000);
  await db.update(alerts).set({ createdAt: past }).where(eq(alerts.conversationId, conv.id));
  await db.update(conversations)
    .set({ lastMessageAt: past, createdAt: past })
    .where(eq(conversations.id, conv.id));
}
expect.sla = 'sla';

console.log('triggers sent — running sweeps + waiting on async classifiers…');
const inactFired = await sweep(db);
const slaFired = await sweepSla(db);
console.log(`sweeps: inactivity=${inactFired} sla=${slaFired}`);

// async classify paths (sentiment, intent re-check) are void-fired — give
// them a beat to land
await new Promise((r) => setTimeout(r, 12_000));

// ── 4. verify ────────────────────────────────────────────────────────────────
const matrixConvs = await db
  .select()
  .from(conversations)
  .where(inArray(conversations.externalId, Object.keys(expect).map(ext)));
const rows = await db
  .select()
  .from(alerts)
  .where(inArray(alerts.conversationId, matrixConvs.map((c) => c.id)))
  .orderBy(desc(alerts.createdAt));

console.log('\n── alert matrix ──');
let ok = true;
for (const [slug, type] of Object.entries(expect)) {
  const conv = matrixConvs.find((c) => c.externalId === ext(slug));
  const hit = rows.find((a) => a.conversationId === conv?.id && a.type === type);
  const mark = hit ? 'OK ' : 'MISS';
  if (!hit) ok = false;
  console.log(
    `${mark} ${type.padEnd(18)} ${hit ? `${hit.status} — ${hit.detail ?? ''}` : 'no alert row'}`,
  );
}

// ── 5. cleanup: rules + SLA config go back; alerts stay open for Mike ────────
await db.delete(alertRules).where(inArray(alertRules.id, ruleIds));
await db.update(agents).set({ config: origConfig }).where(eq(agents.id, agent.id));
console.log(`\ncleaned up rules + restored agent config. ${ok ? 'ALL ALERTS FIRED' : 'MISSES — see above'}`);
process.exit(ok ? 0 : 1);
