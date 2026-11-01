// Records the inbox → approval flow for the landing group-1 figure:
// inbox idles → a fee-waiver approval lands live (SQL insert mid-record)
// → operator opens the thread → Approve & run → agent resumes.
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { BASE, EMAIL, PASSWORD } from './lib.mjs';

const WS = '83ca6ae2-d76d-42e3-8f03-46b97405dfb2';
const CONV = 'eeeb4277-d056-4f0c-8a93-19392fd0fbe1';
const AGENT = '583260b5-a56f-4039-87e6-ca751a6f2ce1';
const ARGS = { fee: '79.00', reason: 'Schedule change after crew delay', booking: 'MA1142 PDX→DEN', customer: 'Dana Whitfield' };

const stage = `WITH act AS (
  INSERT INTO pending_actions (conversation_id, agent_id, workspace_id, tool_name, tool, args, status)
  VALUES ('${CONV}','${AGENT}','${WS}','waive_change_fee','{"name":"waive_change_fee","description":"Waive a flight change fee"}'::jsonb,'${JSON.stringify(ARGS)}'::jsonb,'pending')
  RETURNING id
), msg AS (
  INSERT INTO messages (conversation_id, direction, text, payload, created_at)
  SELECT '${CONV}','out','I can request a fee waiver for you — it just needs a teammate''s approval first.',
    jsonb_build_object('action', jsonb_build_object('id', id, 'name','waive_change_fee','status','pending','description','Waive the change fee for the rebooking','args','${JSON.stringify(ARGS)}'::jsonb)),
    now() FROM act RETURNING id
)
UPDATE pending_actions SET message_id = (SELECT id FROM msg) WHERE id = (SELECT id FROM act);`;

const inbound = `INSERT INTO messages (conversation_id, direction, text, created_at)
  VALUES ('${CONV}','in','the rebook still shows a $79 change fee — is that really still charged after your delay?', now() - interval '20 seconds');
  UPDATE conversations SET last_message_at=now(), last_message_preview='I can request a fee waiver for you — it just needs a teammate''s approval first.', last_message_direction='out', is_unread=true WHERE id='${CONV}';`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: '/tmp/janis-vid3', size: { width: 1440, height: 900 } },
});
const req = ctx.request;
await req.post(`${BASE}/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
await req.post(`${BASE}/auth/switch`, { data: { workspace_id: WS } });

const page = await ctx.newPage();
await page.addInitScript(() => localStorage.setItem('janis_discovery_dismissed', '1'));
await page.goto(`${BASE}/conversations`, { waitUntil: 'networkidle' });
await page.locator('.push-banner-dismiss').click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(2500); // idle inbox beat

// The alert lands on camera (SQL via -f files — no shell quoting).
writeFileSync('/tmp/stage.sql', stage);
writeFileSync('/tmp/inbound.sql', inbound);
execSync(`psql -q postgres://127.0.0.1:5432/janis_dev -f /tmp/stage.sql`);
execSync(`psql -q postgres://127.0.0.1:5432/janis_dev -f /tmp/inbound.sql`);
await page.waitForTimeout(2500); // row bumps to top

// Open the thread, let the card settle, approve.
await page.locator('text=Dana Whitfield').first().click();
await page.locator('button:has-text("Approve & run")').first().waitFor({ timeout: 10000 });
await page.waitForTimeout(2500);
await page.locator('button:has-text("Approve & run")').first().click();
await page.waitForTimeout(14000); // flip + agent reply via SSE
await page.waitForTimeout(1500);

await ctx.close();
await browser.close();
console.log('video in /tmp/janis-vid3');
