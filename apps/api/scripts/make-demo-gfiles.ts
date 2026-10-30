/**
 * Create the three private Google files the OAuth-verification demo needs —
 * a Doc, a Sheet, a Slides deck — on the agent's connected Google account,
 * shared writer-access to the demo/reviewer account. Prints the share links
 * to paste into Teach-it URL sources during the recording.
 *
 * Usage (reads prod DATABASE_URL + JANIS_SECRETS_KEY from .env.production,
 * OAuth client creds from .env):
 *   npx tsx scripts/make-demo-gfiles.ts meekanaron@gmail.com [--agent <agentId>]
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function loadEnvFile(path: string, into: Record<string, string>) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    into[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

const env: Record<string, string> = {};
loadEnvFile(join(root, '.env'), env);
loadEnvFile(join(root, '.env.production'), env);
for (const [k, v] of Object.entries(env)) if (v) process.env[k] = v;

const shareWith = process.argv[2];
if (!shareWith?.includes('@')) {
  console.error('usage: npx tsx scripts/make-demo-gfiles.ts <email> [--agent <agentId>]');
  process.exit(1);
}
const agentArg = process.argv.indexOf('--agent');
const wantAgent = agentArg > 0 ? process.argv[agentArg + 1] : undefined;

const { createDb } = await import('../src/db/client.js');
const { agentConnections } = await import('../src/db/schema.js');
const { connectionToken } = await import('../src/lib/connections.js');

const db = await createDb();
const conn = wantAgent
  ? (
      await db
        .select()
        .from(agentConnections)
        .where(and(eq(agentConnections.agentId, wantAgent), eq(agentConnections.provider, 'google')))
        .limit(1)
    )[0]
  : (
      await db
        .select()
        .from(agentConnections)
        .where(eq(agentConnections.provider, 'google'))
        .limit(1)
    )[0];
if (!conn) {
  console.error('no google connection found');
  process.exit(1);
}
const token = await connectionToken(db, conn);
console.error(`using google connection "${conn.label}"`);

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json as Record<string, unknown>;
}

async function share(fileId: string) {
  await api(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false`, {
    method: 'POST',
    body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: shareWith }),
  });
}

async function createFile(name: string, mimeType: string) {
  const f = (await api('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    body: JSON.stringify({ name, mimeType }),
  })) as { id: string; webViewLink: string };
  await share(f.id);
  return f;
}

// ── Doc ──────────────────────────────────────────────────────────────────
const doc = await createFile(
  'Lead Intake & Follow-up Playbook',
  'application/vnd.google-apps.document',
);
const docText = `LEAD INTAKE & FOLLOW-UP PLAYBOOK — Meridian Realty

First response SLA: reply to every inbound inquiry within 5 minutes during
business hours (8am–8pm). After hours, respond by 9am next day.

Qualification questions, in order:
1. Timeline — "Are you looking to move in the next 30, 60, or 90 days?"
2. Budget — "What range are you comfortable with?" (capture a number, not "depends")
3. Pre-approval — "Have you spoken with a lender?" (yes / in progress / no)
4. Location — neighborhoods or a commute anchor (office, school)
5. Decision maker — "Will anyone else be weighing in on the purchase?"

Routing:
- Buyer under $750k → agent on duty
- Buyer $750k+ or listing inquiry → senior agent (Jonathan)
- Renters → leasing team queue

Follow-up cadence:
Day 0 — answer + booking link
Day 1 — text check-in if no reply
Day 3 — call
Day 7 — email with 3 comparable listings
Day 14 — drop to nurture campaign

Objection handling:
- "Just browsing" → capture email for the weekly new-listings digest
- "Rates too high" → offer the lender intro + rate-buydown explainer
- "Working with another agent" → offer a second-opinion market analysis

Log every lead in the Leads sheet within 10 minutes of the conversation.`;
await api(`https://docs.googleapis.com/v1/documents/${doc.id}:batchUpdate`, {
  method: 'POST',
  body: JSON.stringify({
    requests: [{ insertText: { location: { index: 1 }, text: docText } }],
  }),
});
console.error('doc ok');

// ── Sheet ────────────────────────────────────────────────────────────────
const sheet = await createFile('Leads — Property Inquiries', 'application/vnd.google-apps.spreadsheet');
const rows = [
  ['Name', 'Email', 'Phone', 'Interest', 'Budget', 'Status', 'Notes'],
  ['Sarah Kim', 'sarah.kim@example.com', '416-555-0134', '2-bed condo downtown', '$850k', 'Viewing booked', 'Pre-approved, needs parking'],
  ['Marcus Webb', 'm.webb@example.com', '647-555-0198', 'Family home, High Park', '$1.4M', 'Nurture', 'Timeline 90 days, kids school nearby'],
  ['Priya Anand', 'priya.a@example.com', '416-555-0177', 'Loft, Liberty Village', '$900k', 'New', 'First-time buyer, wants lender intro'],
  ['Tom Becker', 'tbecker@example.com', '905-555-0142', 'Investment duplex', '$1.1M', 'Qualified', 'Cash buyer, quick close'],
];
await api(
  `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/Sheet1!A1:G5?valueInputOption=USER_ENTERED`,
  { method: 'PUT', body: JSON.stringify({ values: rows }) },
);
console.error('sheet ok');

// ── Slides deck ──────────────────────────────────────────────────────────
const pres = (await api('https://slides.googleapis.com/v1/presentations?fields=presentationId,slides', {
  method: 'POST',
  body: JSON.stringify({ title: 'Meridian Realty — Services Overview' }),
})) as {
  presentationId: string;
  slides: { objectId: string; pageElements: { objectId: string }[] }[];
};
await share(pres.presentationId);
const titleIds = pres.slides[0].pageElements.map((e) => e.objectId);
const reqs: Record<string, unknown>[] = [
  { insertText: { objectId: titleIds[0], text: 'Meridian Realty — Services Overview' } },
  { insertText: { objectId: titleIds[1], text: 'Buyer representation · Listings · Investment advisory' } },
];
const deck = (await api(
  `https://slides.googleapis.com/v1/presentations/${pres.presentationId}:batchUpdate`,
  {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        ...reqs,
        {
          createSlide: {
            slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
            placeholderIdMappings: [
              { layoutPlaceholder: { type: 'TITLE' }, objectId: 's2_title' },
              { layoutPlaceholder: { type: 'BODY' }, objectId: 's2_body' },
            ],
          },
        },
        {
          createSlide: {
            slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
            placeholderIdMappings: [
              { layoutPlaceholder: { type: 'TITLE' }, objectId: 's3_title' },
              { layoutPlaceholder: { type: 'BODY' }, objectId: 's3_body' },
            ],
          },
        },
        { insertText: { objectId: 's2_title', text: 'What we do' } },
        {
          insertText: {
            objectId: 's2_body',
            text: 'Buyer representation — search, showings, negotiation, closing\nListing services — pricing strategy, staging, marketing\nInvestment advisory — cap-rate analysis, off-market duplexes',
          },
        },
        { insertText: { objectId: 's3_title', text: 'How we work' } },
        {
          insertText: {
            objectId: 's3_body',
            text: 'Same-day response on every inquiry\nWeekly market reports for active buyers\nSenior agent review on offers over $750k\nPost-close check-ins at 30/90/365 days',
          },
        },
      ],
    }),
  },
)) as Record<string, unknown>;
console.error('deck ok');

console.log(
  JSON.stringify(
    {
      doc: `https://docs.google.com/document/d/${doc.id}/edit`,
      sheet: `https://docs.google.com/spreadsheets/d/${sheet.id}/edit`,
      deck: `https://docs.google.com/presentation/d/${pres.presentationId}/edit`,
      driveLinks: {
        doc: `https://drive.google.com/file/d/${doc.id}/view`,
        deck: `https://drive.google.com/file/d/${pres.presentationId}/view`,
      },
    },
    null,
    2,
  ),
);
process.exit(0);
