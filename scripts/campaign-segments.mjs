/**
 * Segment the legacy user archives into email-campaign buckets and export
 * CSVs. Reads wordhopapi.*_archived, writes to OUT_DIR (default
 * ~/Documents/janis-campaign) — output contains PII, keep it out of git.
 *
 *   MONGODB_URI='…' node scripts/campaign-segments.mjs [out_dir]
 *
 * Segments (first match wins, one email = one person):
 *   A1 paid+owner  — held a real paid plan AND owned/admined a workspace
 *   A2 paid+member — on a paid account but member-only everywhere
 *   B  owners      — is_primary_owner/is_owner/is_admin, never paid
 *   C  engaged     — configured custom_alerts / push_subscriptions / linked
 *                    a slack_integration / any notified_lists lifecycle flag
 *   D  leads       — everyone else with a usable email
 *
 * Paid detection: inner stripe_customer.subscriptions items amount>0
 * (the top-level stripe_subscription field is a $0 tracking shell from
 * a different billing era). `status` merge field = 'active' (still open
 * when legacy froze) or 'unpaid' (closed for failed payment).
 *
 * Always excluded: deleted=true, unsubscribed_lists.*, is_bot, no email,
 * malformed email, internal domains (wordhop.io, janis.ai, janis.local,
 * example/test domains).
 */
import { MongoClient } from 'mongodb';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('set MONGODB_URI');
  process.exit(1);
}
const OUT = process.argv[2] ?? join(homedir(), 'Documents', 'janis-campaign');
const INTERNAL = /@(wordhop\.io|janis\.ai|janis\.local|example\.|test\.|localhost)/i;
const INTERNAL_EXACT = new Set(['michael.nathanson@gmail.com', 'josh@wordhop.io', 'mike@wordhop.io']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.MONGO_DB ?? 'wordhopapi');

// ── pass 1: slack_integrations → payer map keyed by email + si id ──
const payerBySiId = new Map(); // si.id -> {email,name,team,plan,status}
const payerByEmail = new Map();
for await (const d of db.collection('slack_integrations_archived').find()) {
  const email = (d.profile?.email || d.slack_params?.user_email || '').toLowerCase().trim();
  const team = d.slack_params?.team_name || d.profile?.team || '';
  const name = d.profile?.real_name || d.profile?.name || '';
  // Real payers: any inner customer subscription item with amount > 0.
  const paid = (d.stripe_customer?.subscriptions?.data ?? [])
    .flatMap((s) => (s.items?.data ?? []).map((i) => ({ s, p: i.plan })))
    .filter(({ p }) => p?.amount > 0);
  if (paid.length) {
    const top = paid.sort((a, b) => b.p.amount - a.p.amount)[0];
    const rec = {
      email, name, team,
      plan: `${top.p.nickname ?? top.p.id} $${top.p.amount / 100}`,
      status: top.s.status ?? '',
    };
    if (d.id) payerBySiId.set(d.id, rec);
    if (email) payerByEmail.set(email, rec);
  }
}
console.error(`payer installs: ${payerBySiId.size} by-id, ${payerByEmail.size} by-email`);

// ── pass 2: users → person records, segmented ──
const people = new Map(); // email -> record
const skip = { deleted: 0, unsub: 0, bot: 0, noemail: 0, bademail: 0, internal: 0 };
for await (const u of db.collection('users_archived').find({}, {
  projection: { apikey: 0, tokens: 0, google: 0, incomingContexts: 0, data: 0, 'slack.user.access_token': 0 },
})) {
  if (u.is_bot === true) { skip.bot++; continue; }
  if (u.deleted === true) { skip.deleted++; continue; }
  if (u.unsubscribed_lists && Object.values(u.unsubscribed_lists).some(Boolean)) { skip.unsub++; continue; }
  const email = (u.profile?.email || u.slack?.user?.profile?.email || '').toLowerCase().trim();
  if (!email) { skip.noemail++; continue; }
  if (!EMAIL_RE.test(email)) { skip.bademail++; continue; }
  if (INTERNAL.test(email) || INTERNAL_EXACT.has(email)) { skip.internal++; continue; }

  const rec = people.get(email) ?? { email };
  people.set(email, rec);
  rec.name ||= u.profile?.real_name || u.real_name || u.profile?.name || u.name || '';
  rec.first ||= u.profile?.first_name || '';
  rec.team ||= u.workspace_team || u.team_id || '';
  const yr = u.updatedAt instanceof Date ? u.updatedAt.getUTCFullYear() : 0;
  rec.last_active = Math.max(rec.last_active ?? 0, yr);
  rec.owner ||= u.is_primary_owner === true || u.is_owner === true || u.is_admin === true;
  rec.engaged ||= !!(u.custom_alerts || u.push_subscriptions || u.slack_integrations ||
    (u.notified_lists && Object.values(u.notified_lists).some(Boolean)));
  const siId = typeof u.slack_integrations === 'object' ? u.slack_integrations?.id : u.slack_integrations;
  const payer = (siId && payerBySiId.get(siId)) || payerByEmail.get(email);
  if (payer) { rec.payer = true; rec.plan ||= payer.plan; rec.status ||= payer.status; rec.team ||= payer.team; rec.name ||= payer.name; }
  rec.name ||= rec.first;
}

// ── segment + write ──
const segs = { A1_paid_owners: [], A2_paid_members: [], B_owners: [], C_engaged: [], D_leads: [] };
for (const p of people.values()) {
  const seg = p.payer
    ? (p.owner ? 'A1_paid_owners' : 'A2_paid_members')
    : p.owner ? 'B_owners' : p.engaged ? 'C_engaged' : 'D_leads';
  p.segment = seg;
  segs[seg].push(p);
}

mkdirSync(OUT, { recursive: true });
const head = 'email,first_name,name,team,last_active_year,plan,sub_status,segment\n';
const row = (p) => [p.email, p.first ?? '', p.name ?? '', p.team ?? '', p.last_active || '', p.plan ?? '', p.status ?? '', p.segment]
  .map((v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',') + '\n';

let all = head;
for (const [seg, list] of Object.entries(segs)) {
  list.sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
  writeFileSync(join(OUT, `${seg}.csv`), head + list.map(row).join(''));
  all += list.map(row).join('');
  console.error(`${seg.padEnd(12)} ${list.length}`);
}
writeFileSync(join(OUT, 'all_segments.csv'), all);
console.error('excluded:', JSON.stringify(skip));
console.error(`total people: ${people.size} → ${OUT}`);
await client.close();
