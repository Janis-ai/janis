#!/usr/bin/env node
/**
 * campaign-hygiene.mjs — free first-pass list hygiene for the relaunch
 * campaign CSVs in ~/Documents/janis-campaign/.
 *
 * For every *_<segment>.csv (or --file): emits <seg>_verified.csv
 * (deliverable-likely rows) and appends rejects to dropped.csv with a
 * reason column. Checks, in order:
 *   1. syntax         — parseable addr-spec, punycode-safe, no dots edge cases
 *   2. disposable     — known throwaway domains
 *   3. role           — info@/admin@/noreply@… (flagged, not dropped — a
 *                       role address that once paid is still a real inbox;
 *                       dropped only with --drop-role)
 *   4. dedupe         — case-insensitive, +tag-normalized for freemail
 *   5. mx             — domain has MX or A record (DNS, ~50-way parallel)
 *   6. prior-unsubs   — ~/Documents/janis-campaign/unsubscribes.txt if present
 *
 * What this does NOT catch: catch-all domains that accept-then-bounce,
 * spam traps, dead inboxes on live domains. That needs NeverBounce/
 * ZeroBounce — run the verified CSVs through one before sending (the
 * campaign.md says the same thing).
 *
 * Usage:
 *   node scripts/campaign-hygiene.mjs [--dir ~/Documents/janis-campaign]
 *                                     [--drop-role] [--skip-mx]
 */
import { promises as dns } from 'node:dns';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: join(homedir(), 'Documents/janis-campaign') },
    file: { type: 'string' },
    'drop-role': { type: 'boolean', default: false },
    'skip-mx': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '50' },
  },
});

const DIR = args.dir;
const CONC = parseInt(args.concurrency, 10);

const DISPOSABLE = new Set([
  'mailinator.com','guerrillamail.com','10minutemail.com','tempmail.com',
  'temp-mail.org','yopmail.com','trashmail.com','sharklasers.com',
  'maildrop.cc','getairmail.com','dispostable.com','mailnesia.com',
  'mailcatch.com','mintemail.com','mohmal.com','throwawaymail.com',
  'getnada.com','inboxkitten.com','emailondeck.com','tempinbox.com',
  'fakeinbox.com','spamgourmet.com','mytrashmail.com','mailhazard.com',
  'mailexpire.com','spam4.me','tempr.email','discard.email','mailsac.com',
]);
const ROLE_LOCAL = /^(info|admin|administrator|support|sales|contact|office|noreply|no-reply|postmaster|webmaster|abuse|marketing|billing|mailer-daemon|root|hostmaster)@/i;
// freemail providers where a+tag is same inbox → dedupe on bare local part
const TAGGABLE = new Set(['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','icloud.com','me.com','proton.me','protonmail.com','fastmail.com','yahoo.com','yandex.com','zoho.com']);

function parseCsvLine(line) {
  // minimal RFC4180: quoted fields may contain commas/quotes
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function syntaxOk(email) {
  if (!email || email.length > 254 || email.includes(' ')) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  const local = email.slice(0, at), domain = email.slice(at + 1).toLowerCase();
  if (local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) return false;
  const tld = domain.split('.').pop();
  return tld.length >= 2;
}

function normalized(email) {
  const [l, d] = email.toLowerCase().split('@');
  if (TAGGABLE.has(d)) {
    const bare = l.split('+')[0].replace(d === 'gmail.com' || d === 'googlemail.com' ? /\./g : /()/, '');
    return `${bare}@${d === 'googlemail.com' ? 'gmail.com' : d}`;
  }
  return email.toLowerCase();
}

async function resolveMx(domain) {
  try { const r = await dns.resolveMx(domain); if (r.length) return 'mx'; } catch {}
  try { const r = await dns.resolve4(domain); if (r.length) return 'a'; } catch {}
  try { const r = await dns.resolveCname(domain); if (r.length) return 'a'; } catch {}
  return null;
}

async function mapPool(items, conc, fn) {
  const res = new Map();
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      res.set(items[i], await fn(items[i]));
    }
  }));
  return res;
}

const files = args.file
  ? [basename(args.file)]
  : readdirSync(DIR).filter((f) => /^[A-D]\d?_/.test(f) && f.endsWith('.csv') && !f.includes('_verified'));

const unsubFile = join(DIR, 'unsubscribes.txt');
const unsub = new Set(
  existsSync(unsubFile)
    ? readFileSync(unsubFile, 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [],
);
if (unsub.size) console.log(`loaded ${unsub.size} prior unsubscribes from ${unsubFile}`);

const dropped = [];
const allRows = [];
for (const f of files) {
  const raw = readFileSync(join(DIR, f), 'utf8');
  const [head, ...lines] = raw.trimEnd().split('\n');
  const cols = parseCsvLine(head);
  const emailIdx = cols.indexOf('email');
  if (emailIdx < 0) { console.log(`skip ${f}: no email column`); continue; }
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = parseCsvLine(line);
    allRows.push({ file: f, cols, row, email: (row[emailIdx] || '').trim(), line });
  }
}
console.log(`loaded ${allRows.length} rows from ${files.length} file(s)`);

// --- deterministic gates -----------------------------------------------------
const seen = new Set();
const candidates = [];
for (const r of allRows) {
  const e = r.email.toLowerCase();
  if (!syntaxOk(e)) { dropped.push([r.file, e, 'syntax']); continue; }
  const domain = e.split('@')[1];
  if (DISPOSABLE.has(domain)) { dropped.push([r.file, e, 'disposable']); continue; }
  if (unsub.has(e) || unsub.has(normalized(e))) { dropped.push([r.file, e, 'prior-unsubscribe']); continue; }
  if (ROLE_LOCAL.test(e)) {
    if (args['drop-role']) { dropped.push([r.file, e, 'role-account']); continue; }
    r.role = true; // surfaced in verified output as an extra col
  }
  const n = normalized(e);
  if (seen.has(n)) { dropped.push([r.file, e, 'duplicate']); continue; }
  seen.add(n);
  r.domain = domain;
  candidates.push(r);
}

// --- MX gate ------------------------------------------------------------------
let mxMap = new Map();
if (!args['skip-mx']) {
  const domains = [...new Set(candidates.map((r) => r.domain))];
  console.log(`MX-resolving ${domains.length} unique domains…`);
  mxMap = await mapPool(domains, CONC, resolveMx);
}
const verified = [];
for (const r of candidates) {
  if (!args['skip-mx'] && !mxMap.get(r.domain)) { dropped.push([r.file, r.email.toLowerCase(), 'no-mx']); continue; }
  verified.push(r);
}

// --- write --------------------------------------------------------------------
const dropPath = join(DIR, 'dropped.csv');
writeFileSync(dropPath, `file,email,reason\n${dropped.map((d) => d.join(',')).join('\n')}\n`);
for (const f of files) {
  const rows = verified.filter((r) => r.file === f);
  if (!rows.length) continue;
  const hasRole = rows.some((r) => r.role);
  const out = join(DIR, f.replace('.csv', '_verified.csv'));
  const head = rows[0].cols.join(',') + (hasRole ? ',role_flag' : '');
  writeFileSync(out, `${head}\n${rows.map((r) => `${r.line}${r.role ? ',role' : ''}`).join('\n')}\n`);
}
const byReason = dropped.reduce((m, d) => ((m[d[2]] = (m[d[2]] || 0) + 1), m), {});
console.log(`\nverified: ${verified.length}  dropped: ${dropped.length}`);
for (const [k, v] of Object.entries(byReason)) console.log(`  ${k}: ${v}`);
for (const f of files) {
  const kept = verified.filter((r) => r.file === f).length;
  const gone = dropped.filter((d) => d[0] === f).length;
  console.log(`  ${f}: ${kept} kept, ${gone} dropped`);
}
console.log(`\nnext: run the _verified CSVs through NeverBounce/ZeroBounce for the catch-all layer — this pass only removed the obviously dead.`);
