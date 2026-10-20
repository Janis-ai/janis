#!/usr/bin/env node
/**
 * campaign-render.mjs — render per-recipient send files for the A
 * segments (personal sends via Gmail merge/YAMM/hand).
 *
 * Reads A1_paid_owners_verified.csv + A2_paid_members_verified.csv,
 * applies the campaign.md copy with merge fields + sub_status variant
 * line, and writes per-segment files ready for a mail merge:
 *   <seg>_send.csv  → to,subject,body (one personalized row per recipient)
 *   <seg>_send.txt  → every rendered email in one file for eyeball review
 *
 * {{unsubscribe}} is rendered literally as a placeholder — the merge
 * tool (or Mike's hand-edit) supplies the real link.
 *
 * Usage: node scripts/campaign-render.mjs [--dir ~/Documents/janis-campaign]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { dir: { type: 'string', default: join(homedir(), 'Documents/janis-campaign') } },
});
const DIR = args.dir;

const T = {
  A1_paid_owners: {
    subject: 'Janis is back',
    body: `Hi {{first_name}},

You paid for {{plan}} on the {{team}} workspace back when Janis was a Slack bot builder. I'm Mike — I built it, wound it down, and I've spent the last stretch rebuilding it properly.
{{variant}}
Same job — a bot that answers for your business — except now it actually works the way we wanted it to in 2018: real language model underneath, knowledge it learns from your docs, email/Slack/Instagram/web chat channels, and a proper console to run it.

If you still run the kind of operation that needed it then, I'd love you to see it: https://app.janis.ai

And if you reply and tell me what you were building back then, I'll tell you honestly whether it's worth your time now.

— Mike

(you had {{plan}} on {{team}} — one email, that's it — unsubscribe and you'll never hear from me again: {{unsubscribe}})`,
  },
  A2_paid_members: {
    subject: 'Janis is back',
    body: `Hi {{first_name}},

Your team on {{team}} paid for Janis back when it was a Slack bot builder — you were one of the people inside it. I'm Mike, the founder. I shut it down and rebuilt it from scratch.

The rebuilt version does the same job — answering for the business — but it's a concierge now, not a toolkit: it reads your docs and answers customers on web chat, email, Slack, and Instagram, and hands off to a human when it shouldn't guess.

If you're the person who kept it running back then: it's a completely different (much less manual) product now. If you're somewhere new and own the "repetitive questions" problem there — even better.

Two minutes: https://app.janis.ai

— Mike

(one email, that's it — unsubscribe and you'll never hear from me again: {{unsubscribe}})`,
  },
};
const VARIANT = {
  active: 'Your plan was still live when the old system froze — as far as Stripe was concerned you were a paying customer right up to the end.',
  unpaid: 'It lapsed at some point — everyone churns eventually — but you saw enough to pay for it once.',
};

function parseCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}
const csvEsc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;

for (const [seg, tpl] of Object.entries(T)) {
  const file = join(DIR, `${seg}_verified.csv`);
  let raw;
  try { raw = readFileSync(file, 'utf8').trimEnd().split('\n'); }
  catch { console.log(`skip ${seg}: no verified csv`); continue; }
  const cols = parseCsvLine(raw[0]);
  const idx = (k) => cols.indexOf(k);
  const rows = raw.slice(1).filter(Boolean).map(parseCsvLine);
  const rendered = [];
  const txt = [];
  for (const row of rows) {
    const f = (k) => (idx(k) >= 0 ? (row[idx(k)] || '').trim() : '');
    const rawFirst = f('first_name') || f('name').split(' ')[0] || '';
    const first = rawFirst
      ? rawFirst.replace(/[._-]+/g, ' ').trim().split(' ')[0]
      : 'there';
    const status = f('sub_status');
    const variant = VARIANT[status] ? `\n\n${VARIANT[status]}\n` : '\n';
    const body = tpl.body
      .replace(/\{\{first_name\}\}/g, first)
      .replace(/\{\{plan\}\}/g, f('plan') || 'Janis')
      .replace(/\{\{team\}\}/g, f('team'))
      .replace('{{variant}}', variant)
      .replace(/\{\{unsubscribe\}\}/g, '{UNSUBSCRIBE}');
    rendered.push({ to: f('email').toLowerCase(), subject: tpl.subject, body });
    txt.push(`=== ${f('email')} ===\nSubject: ${tpl.subject}\n\n${body}\n`);
  }
  const outCsv = join(DIR, `${seg}_send.csv`);
  const outTxt = join(DIR, `${seg}_send.txt`);
  writeFileSync(outCsv, `to,subject,body\n${rendered.map((r) => `${csvEsc(r.to)},${csvEsc(r.subject)},${csvEsc(r.body)}`).join('\n')}\n`);
  writeFileSync(outTxt, txt.join('\n'));
  console.log(`${seg}: ${rendered.length} rendered → ${outCsv} (+ .txt review copy)`);
}
