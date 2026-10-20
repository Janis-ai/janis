#!/usr/bin/env node
/**
 * campaign-import.mjs — load verified campaign CSVs into Resend Contacts.
 *
 * One Segment per segment file (relaunch-2026-A1_paid_owners, …); contacts
 * are created globally with merge fields under `properties` and attached
 * to their segment. Resume-safe: a state file records which
 * (segment,email) pairs were imported, so re-runs skip done work.
 * Existing contacts that 409 get PATCHed onto the segment WITHOUT touching
 * their global `unsubscribed` status. DRY-RUN IS THE DEFAULT —
 * pass --commit to hit the API.
 *
 * Env: RESEND_API_KEY (reads apps/api/.env.production if unset).
 *
 * Usage:
 *   node scripts/campaign-import.mjs            # dry run, prints the plan
 *   node scripts/campaign-import.mjs --commit   # actually create+import
 *   node scripts/campaign-import.mjs --commit --file A1_paid_owners_verified.csv
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: join(homedir(), 'Documents/janis-campaign') },
    file: { type: 'string' },
    commit: { type: 'boolean', default: false },
    'rate-ms': { type: 'string', default: '120' }, // ~8 req/s, under Resend limits
    'prefix': { type: 'string', default: 'relaunch-2026' },
  },
});
const DIR = args.dir;
const STATE = join(DIR, '.import-state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let key = process.env.RESEND_API_KEY;
if (!key) {
  const envFile = join(homedir(), 'repos/janis/apps/api/.env.production');
  const m = readFileSync(envFile, 'utf8').match(/^RESEND_API_KEY=(.+)$/m);
  key = m && m[1].trim().replace(/^"|"$/g, '');
}
if (!key) { console.error('RESEND_API_KEY not found'); process.exit(1); }

const api = async (method, path, body) => {
  const res = await fetch(`https://api.resend.com${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: j };
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

const files = args.file
  ? [args.file]
  : readdirSync(DIR).filter((f) => f.endsWith('_verified.csv'));
if (!files.length) { console.error('no *_verified.csv files — run campaign-hygiene.mjs first'); process.exit(1); }

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { segments: {}, contacts: {} };
// tolerate the old state schema
state.segments ??= {}; state.contacts ??= {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));

// 1. resolve/create segments -------------------------------------------------
const list = await api('GET', '/segments');
const existingSegs = list.body?.data ?? list.body ?? [];
const byName = new Map((Array.isArray(existingSegs) ? existingSegs : []).map((s) => [s.name, s.id]));
for (const f of files) {
  const seg = f.replace(/_verified\.csv$/, '').replace(/\.csv$/, '');
  const name = `${args.prefix}-${seg}`;
  const id = state.segments[seg] ?? byName.get(name);
  if (id) { state.segments[seg] = id; continue; }
  if (!args.commit) { console.log(`[dry] would create segment "${name}"`); continue; }
  const r = await api('POST', '/segments', { name });
  if (!r.ok) { console.error(`segment create failed: ${JSON.stringify(r.body).slice(0, 200)}`); process.exit(1); }
  state.segments[seg] = r.body.id;
  save();
  console.log(`created segment "${name}" → ${r.body.id}`);
}

// 2. import contacts ---------------------------------------------------------
let done = 0, skipped = 0, failed = 0;
for (const f of files) {
  const seg = f.replace(/_verified\.csv$/, '').replace(/\.csv$/, '');
  const segmentId = state.segments[seg];
  const raw = readFileSync(join(DIR, f), 'utf8').trimEnd().split('\n');
  const cols = parseCsvLine(raw[0]);
  const idx = (k) => cols.indexOf(k);
  const rows = raw.slice(1).filter(Boolean).map(parseCsvLine);
  console.log(`\n${f}: ${rows.length} contacts → segment ${segmentId ?? '(dry)'}`);
  for (const row of rows) {
    const email = (row[idx('email')] || '').trim().toLowerCase();
    if (!email) continue;
    const stKey = `${seg}:${email}`;
    if (state.contacts[stKey] === true) { skipped++; continue; }
    const contact = {
      email,
      first_name: row[idx('first_name')] || '',
      last_name: row[idx('name')] && row[idx('name')] !== row[idx('first_name')] ? row[idx('name')] : '',
      // NOTE: `unsubscribed` deliberately omitted — new contacts default to
      // subscribed, and we never want to re-subscribe a prior opt-out.
      properties: {
        segment: seg,
        ...(idx('team') >= 0 ? { team: row[idx('team')] || '' } : {}),
        ...(idx('plan') >= 0 ? { plan: row[idx('plan')] || '' } : {}),
        ...(idx('last_active_year') >= 0 ? { last_active_year: row[idx('last_active_year')] || '' } : {}),
      },
      segments: segmentId ? [{ id: segmentId }] : [],
    };
    if (!args.commit) {
      if (done === 0) console.log('[dry] sample contact:', JSON.stringify(contact).slice(0, 400));
      done++;
      continue;
    }
    const r = await api('POST', '/contacts', contact);
    if (r.ok) {
      state.contacts[stKey] = true;
      done++;
    } else if (r.status === 409) {
      // contact already exists — attach to segment, preserve unsubscribed
      const p = await api('PATCH', `/contacts/${encodeURIComponent(email)}`, { segments: [{ id: segmentId }] });
      if (p.ok) { state.contacts[stKey] = true; done++; }
      else {
        failed++;
        console.log(`  FAIL(patch) ${email}: ${JSON.stringify(p.body).slice(0, 200)}`);
        state.contacts[stKey] = `error:${JSON.stringify(p.body).slice(0, 120)}`;
      }
    } else {
      failed++;
      console.log(`  FAIL ${email}: ${JSON.stringify(r.body).slice(0, 200)}`);
      state.contacts[stKey] = `error:${JSON.stringify(r.body).slice(0, 120)}`;
    }
    if (done % 250 === 0) { console.log(`  …${done} imported`); save(); }
    await sleep(parseInt(args['rate-ms'], 10));
  }
  save();
}
console.log(`\n${args.commit ? 'imported' : '[dry] would import'}: ${done}, skipped(resume): ${skipped}, failed: ${failed}`);
if (!args.commit) console.log('pass --commit to run for real.');
