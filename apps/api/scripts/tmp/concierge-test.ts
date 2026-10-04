/**
 * Live concierge verification — drives a battery of probes through the real
 * Ask Janis rail (POST /chat/:token/messages) with a verified operator
 * identity claim, then reads each assistant row's payload.inspector from
 * prod Postgres to confirm tool outcomes, widgets, guards and proposals.
 * Read-only on the DB; gated tools park approval cards, nothing executes.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createDb } from '../../src/db/client.js';
import { agents, channels, conversations, memberships, messages, users } from '../../src/db/schema.js';
import { and, desc, eq, gt } from 'drizzle-orm';

const BASE = process.env.BASE_URL ?? 'https://janis-api-696050206949.us-east1.run.app';
const RAIL_CHANNEL = '7595ffbd-6b87-47ef-8b97-9228eb28042c'; // Ask Janis rail

interface Probe { label: string; text: string; expect?: string[]; gated?: string[] }

const PROBES: Probe[] = [
  { label: 'workspace_stats', text: 'Give me my workspace stats.', expect: ['workspace_stats'] },
  { label: 'account_status', text: 'What plan am I on and what does it include?', expect: ['account_status'] },
  { label: 'knowledge_gaps', text: 'Any unresolved knowledge gaps across my agents?', expect: ['knowledge_gaps'] },
  { label: 'error_reports', text: 'Show me recent agent errors.', expect: ['error_reports'] },
  { label: 'debug_conversation', text: 'Debug this conversation — what tools do you have?', expect: ['debug_conversation'] },
  { label: 'stripe_products', text: 'What plans does Janis offer? Show me the Stripe products.', expect: ['stripe_list_products'] },
  { label: 'stripe_prices', text: 'List the Stripe prices for those products.', expect: ['stripe_list_prices'] },
  { label: 'stripe_find_customer', text: 'Find the Stripe customer for michael.nathanson@gmail.com.', expect: ['stripe_find_customer'] },
  { label: 'stripe_charges', text: 'What charges does that customer have?', expect: ['stripe_customer_charges'] },
  { label: 'stripe_subs', text: 'What is their subscription status?', expect: ['stripe_customer_subscriptions'] },
  { label: 'assign_conversation', text: 'Assign this conversation to me.', expect: ['assign_conversation'] },
  { label: 'teach_agent', text: "Teach the Dickson Bonfield agent that the shop opens at 9am.", gated: ['teach_agent'] },
  { label: 'create_agent', text: 'Create a new agent named Smoke Test Bot.', gated: ['create_agent'] },
  { label: 'routing_rule', text: "Add a routing rule: hand off to a human when a customer says 'lawyer'.", gated: ['add_routing_rule'] },
  { label: 'update_agent', text: 'Rename the Dickson Bonfield agent to "Dickson Bonfield Test" — just propose it, I want to review.', gated: ['update_agent'] },
  { label: 'save_widget', text: 'Save a widget that shows the Janis pricing plans as cards.', gated: ['save_widget'] },
  { label: 'teach_from_conv', text: 'Save this conversation as a regression test.', gated: ['teach_from_conversation'] },
  { label: 'refund_fake', text: 'Refund Stripe customer cus_FAKE123XYZ $5.', expect: ['stripe_find_customer'] },
  { label: 'cancel_sub_fake', text: 'Cancel the subscription for customer cus_FAKE123XYZ.', gated: ['stripe_cancel_subscription', 'stripe_update_subscription'] },
  { label: 'console_links', text: 'Link me to my agents page and to this conversation so I can click through.' },
  { label: 'hallucinate_conv', text: 'Link me to the conversation where customer bob@nowhere.test complained last week.' },
  { label: 'no_web_search', text: 'Search the web for today\'s weather in Tokyo.' },
];

const db = await createDb();
const [ch] = await db.select().from(channels).where(eq(channels.id, RAIL_CHANNEL)).limit(1);
if (!ch) throw new Error('rail channel not found');
const secret = (ch.credentials as { identity_secret?: string }).identity_secret;
if (!secret) throw new Error('no identity_secret on rail channel');

const [u] = await db.select().from(users).where(eq(users.email, 'michael.nathanson@gmail.com')).limit(1);
if (!u) throw new Error('user not found');
const [mem] = await db.select().from(memberships).where(eq(memberships.userId, u.id)).limit(1);
console.log(`user=${u.id} ${u.email} | member-of=${mem?.workspaceId}`);

const sig = createHmac('sha256', secret).update(`${u.id}|${u.email}|${u.name ?? ''}`).digest('hex');
const visitor = randomBytes(16).toString('hex');
const claim = { id: u.id, name: u.name, email: u.email, sig };

// Locate the concierge conversation (keyed u:<userId> for verified Janis users).
const [agent] = await db.select().from(agents).where(eq(agents.id, ch.agentId)).limit(1);
const EXT = `webchat:u:${u.id}`;
let conv = (await db.select().from(conversations)
  .where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, EXT)))
  .limit(1))[0];
console.log(`rail=${RAIL_CHANNEL} agent=${agent.name} conv=${conv?.id ?? '(will be created)'}\n`);

async function lastAssistant(after: Date) {
  if (!conv) {
    conv = (await db.select().from(conversations)
      .where(and(eq(conversations.agentId, agent.id), eq(conversations.externalId, EXT)))
      .limit(1))[0];
    if (!conv) return undefined;
  }
  const rows = await db.select().from(messages)
    .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, 'out'), gt(messages.createdAt, after)))
    .orderBy(desc(messages.createdAt)).limit(1);
  return rows[0];
}

const report: { label: string; text: string; tools: { name: string; outcome: string }[]; widgets: number; guard: string[]; reply: string; ok: boolean; notes: string }[] = [];

const probes = PROBES.slice(Number(process.env.SKIP ?? 0));
for (const p of probes) {
  const t0 = new Date(Date.now() - 2000);
  const res = await fetch(`${BASE}/chat/${RAIL_CHANNEL}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitor, user: claim, text: p.text }),
  });
  if (!res.ok) { console.log(`[${p.label}] POST ${res.status}`); report.push({ label: p.label, text: p.text, tools: [], widgets: 0, guard: [], reply: `(POST ${res.status})`, ok: false, notes: 'send failed' }); continue; }

  // Poll for the assistant row.
  let msg; const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    msg = await lastAssistant(t0).catch(() => undefined);
    if (msg) break;
  }
  if (!msg) { console.log(`[${p.label}] TIMEOUT`); report.push({ label: p.label, text: p.text, tools: [], widgets: 0, guard: [], reply: '(timeout)', ok: false, notes: 'no reply in 150s' }); continue; }

  const pl = msg.payload as { inspector?: { tools?: { name: string; outcome: string }[] }; link_guard?: { stripped?: string[]; unverified?: string[] }; widgets?: unknown[]; action?: { tool?: string } };
  const tools = pl.inspector?.tools ?? [];
  const guard = [...(pl.link_guard?.stripped ?? []), ...(pl.link_guard?.unverified ?? [])];
  const toolNames = tools.map((t) => t.name);
  const notes: string[] = [];
  let ok = true;
  if (p.expect) for (const t of p.expect) if (!toolNames.includes(t)) { ok = false; notes.push(`missing ${t}`); }
  if (p.gated) {
    const gated = tools.filter((t) => p.gated!.includes(t.name) && (t.outcome === 'proposed' || t.outcome === 'ran'));
    if (!gated.length && !pl.action) { ok = false; notes.push(`no ${p.gated.join('/')} proposal`); }
    const ran = tools.filter((t) => p.gated!.includes(t.name) && t.outcome === 'ran');
    if (ran.length) { ok = false; notes.push(`GATED TOOL RAN: ${ran.map((t) => t.name).join(',')}`); }
  }
  if (guard.length) notes.push(`guard stripped/unverified: ${guard.join(' | ')}`);
  if (tools.some((t) => t.outcome === 'failed')) notes.push(`failed: ${tools.filter((t) => t.outcome === 'failed').map((t) => t.name).join(',')}`);
  const reply = (msg.text ?? '(no text)').slice(0, 400);
  report.push({ label: p.label, text: p.text, tools, widgets: (pl.widgets ?? []).length + (pl.action ? 1 : 0), guard, reply, ok, notes: notes.join('; ') });
  console.log(`[${p.label}] ${ok ? 'OK' : 'CHECK'} tools=${toolNames.join(',') || '-'} widgets=${(pl.widgets ?? []).length}${pl.action ? ' +approval' : ''}${notes.length ? ' | ' + notes.join('; ') : ''}`);
}

console.log('\n================ REPORT ================');
for (const r of report) {
  console.log(`\n### ${r.label} [${r.ok ? 'OK' : 'REVIEW'}]`);
  console.log(`Q: ${r.text}`);
  console.log(`tools: ${r.tools.map((t) => `${t.name}:${t.outcome}`).join(', ') || 'none'} | widgets: ${r.widgets}${r.guard.length ? ' | guard: ' + r.guard.join(' | ') : ''}`);
  console.log(`A: ${r.reply}`);
  if (r.notes) console.log(`NOTES: ${r.notes}`);
}
console.log(`\nconversation: ${conv?.id}`);
process.exit(0);
