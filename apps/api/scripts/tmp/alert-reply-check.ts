// Alert → reply regression check: fire every alert type on a dedicated conv,
// then send a follow-up customer message through the real ingest→webhook path
// and require a hosted reply. Guards the "internal notes counted as replies"
// bug class across all alert kinds, not just sentiment.
// Run: DATABASE_URL="$(grep '^DATABASE_URL' .env.production | cut -d= -f2-)" \
//   npx tsx scripts/tmp/alert-reply-check.ts
import '../../src/loadEnv.js';
import { createDb } from '../../src/db/client.js';
import { agents, alertRules, alerts, conversations, messages, users } from '../../src/db/schema.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { processEvents } from '../../src/services/ingest.js';
import { sweep, sweepSla } from '../../src/services/sweeper.js';
import { fireErrorAlert } from '../../src/lib/ruleAlerts.js';
import { requestToolApproval } from '../../src/lib/approvals.js';
import { captureCsat } from '../../src/lib/csat.js';
import { deliverWebhook } from '../../src/lib/webhooks.js';
import type { ToolDef } from '../../src/lib/toolExec.js';

const AGENT_ID = '13e45248-77e9-4006-b8a5-76c442e522bd';
const MIKE_EMAIL = 'michael.nathanson@gmail.com';
const STAMP = Date.now().toString(36);
const ext = (slug: string) => `replycheck-${slug}-${STAMP}`;

const db = await createDb();
const [mike] = await db.select().from(users).where(eq(users.email, MIKE_EMAIL)).limit(1);
if (!mike) throw new Error('mike not found');
const [agent] = await db.select().from(agents).where(eq(agents.id, AGENT_ID)).limit(1);
if (!agent) throw new Error('concierge not found');
console.log(`agent=${agent.name} hosted=${agent.hosted} ws=${agent.workspaceId}`);

// one enabled rule per kind routed at Mike (same as alert-full-matrix)
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
const origConfig = (agent.config ?? {}) as Record<string, unknown>;
await db.update(agents).set({ config: { ...origConfig, sla_minutes: 1 } }).where(eq(agents.id, agent.id));
console.log(`seeded ${ruleIds.length} rules + sla_minutes=1`);

async function convFor(slug: string) {
  const [c] = await db.select().from(conversations).where(eq(conversations.externalId, ext(slug))).limit(1);
  return c!;
}
async function ingest(slug: string, events: Parameters<typeof processEvents>[2]) {
  await processEvents(db, agent, events.map((e) => ({ ...e, conversation_id: ext(slug) })) as never);
}

const expect: Record<string, string> = {};

// ── triggers (same as alert-full-matrix) ────────────────────────────────────
await ingest('keyword', [{ type: 'message_in', text: 'this message has matrixkeyword inside' }]);
expect.keyword = 'keyword';
await ingest('intent', [{ type: 'message_in', text: 'hi', payload: { intent: 'matrix_topic' } }]);
expect.intent = 'intent';
await ingest('sentiment', [
  { type: 'message_in', text: 'I am absolutely furious — this is the worst service I have ever used' },
]);
expect.sentiment = 'sentiment';
await ingest('failure', [{ type: 'failure', reason: 'matrix test failure' }]);
expect.failure = 'failure';
await ingest('help', [{ type: 'handoff_request', reason: 'customer asked for a human' }]);
expect.help = 'help_request';
await ingest('offer', [{ type: 'handoff_offer', reason: 'would you like a human?' }]);
expect.offer = 'handoff_offer';
await ingest('custom', [{ type: 'custom_alert', alert_type: 'matrix_custom_signal' }]);
expect.custom = 'custom';
await ingest('error', [{ type: 'message_in', text: 'hi for error conv' }]);
await fireErrorAlert(db, agent, (await convFor('error')).id, 'matrix test run error');
expect.error = 'error';
await ingest('approval', [{ type: 'message_in', text: 'refund order o-42 please' }]);
const GATED: ToolDef = {
  name: 'refund_order', description: 'refund it', method: 'POST', approval: true,
  url: 'http://localhost:9/api/refund', params: { order_id: 'id' },
};
await requestToolApproval(db, agent, (await convFor('approval')).id, GATED, { order_id: 'o-42' });
expect.approval = 'approval_request';
await ingest('csat', [{ type: 'message_in', text: 'hello csat conv' }]);
{
  const conv = await convFor('csat');
  await db.update(conversations).set({ csatPending: true }).where(eq(conversations.id, conv.id));
  await captureCsat(db, { ...conv, csatPending: true }, '2');
}
expect.csat = 'csat';
await ingest('inact', [{ type: 'message_in', text: 'anyone there?' }]);
{
  const conv = await convFor('inact');
  await db.update(conversations)
    .set({ lastMessageDirection: 'in', lastMessageAt: new Date(Date.now() - 120_000) })
    .where(eq(conversations.id, conv.id));
}
expect.inact = 'inactivity';
await ingest('sla', [{ type: 'handoff_request', reason: 'sla seed handoff' }]);
{
  const conv = await convFor('sla');
  const past = new Date(Date.now() - 120_000);
  await db.update(alerts).set({ createdAt: past }).where(eq(alerts.conversationId, conv.id));
  await db.update(conversations).set({ lastMessageAt: past, createdAt: past }).where(eq(conversations.id, conv.id));
}
expect.sla = 'sla';

console.log('triggers sent — running sweeps + waiting on async classifiers…');
const inactFired = await sweep(db);
const slaFired = await sweepSla(db);
console.log(`sweeps: inactivity=${inactFired} sla=${slaFired}`);
// restore SLA config immediately after the sweep — narrow the blast radius
await db.update(agents).set({ config: origConfig }).where(eq(agents.id, agent.id));
await new Promise((r) => setTimeout(r, 12_000));

// ── phase 1: every alert open ────────────────────────────────────────────────
const matrixConvs = await db.select().from(conversations)
  .where(inArray(conversations.externalId, Object.keys(expect).map(ext)));
const alertRows = await db.select().from(alerts)
  .where(inArray(alerts.conversationId, matrixConvs.map((c) => c.id)));

console.log('\n── phase 1: alerts ──');
const results: { slug: string; type: string; alert: boolean; reply: boolean; via?: string }[] = [];
for (const [slug, type] of Object.entries(expect)) {
  const conv = matrixConvs.find((c) => c.externalId === ext(slug));
  const hit = alertRows.find((a) => a.conversationId === conv?.id && a.type === type && a.status === 'open');
  results.push({ slug, type, alert: !!hit, reply: false });
  console.log(`${hit ? 'OK ' : 'MISS'} ${type}`);
}

// ── phase 2: follow-up inbound → hosted reply required ──────────────────────
console.log('\n── phase 2: follow-up replies ──');
for (const r of results) {
  if (!r.alert) { console.log(`SKIP ${r.type} — no alert`); continue; }
  const conv = await convFor(r.slug);
  // real path: processEvents stores the inbound (and void-fires the async
  // classifiers that write the very notes that used to suppress replies),
  // then deliverWebhook dispatches the hosted run exactly like channelIngress.
  await processEvents(db, agent, [
    { type: 'message_in', conversation_id: ext(r.slug), text: 'still there? need an update' } as never,
  ]);
  const [followup] = await db.select().from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(desc(messages.createdAt)).limit(1);
  await deliverWebhook(db, agent, 'message.user', {
    conversation_id: ext(r.slug),
    janis_conversation_id: conv.id,
    text: 'still there? need an update',
  } as never);

  const deadline = Date.now() + 60_000;
  let reply: { via?: string } | undefined;
  while (Date.now() < deadline) {
    const [row] = await db
      .select({ payload: messages.payload, flags: messages.flags, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conv.id),
          eq(messages.direction, 'out'),
          sql`coalesce(${messages.payload}->>'internal', 'false') <> 'true'`,
          sql`${messages.createdAt} > ${followup.createdAt.toISOString()}`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const flags = (row?.flags ?? {}) as { failure?: boolean };
    if (row && !flags.failure) { reply = (row.payload ?? {}) as { via?: string }; break; }
    await new Promise((s) => setTimeout(s, 1_500));
  }
  r.reply = !!reply;
  r.via = reply?.via;
  console.log(`${r.reply ? 'OK ' : 'FAIL'} ${r.type.padEnd(18)} reply via=${r.via ?? '—'}`);
}

// ── cleanup ──────────────────────────────────────────────────────────────────
await db.delete(alertRules).where(inArray(alertRules.id, ruleIds));
const allOk = results.every((r) => r.alert && r.reply);
console.log(`\n${allOk ? 'ALL ALERTS FIRED + ALL FOLLOW-UPS REPLIED' : 'FAILURES — see above'}`);
process.exit(allOk ? 0 : 1);
