// Meta Platform Term 7.a screencast — George Harrison demo account.
// Real headed Chrome (URL bar + menu clock in frame) + ffmpeg screen capture.
//   REVIEW_PASS=<gh account pw> node scripts/ui/meta-screencast.mjs
// Pauses at Meta OAuth so the operator can click through live on camera,
// then waits for a real inbound DM to land before continuing.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';

const APP = 'https://app.janis.ai';
const EMAIL = 'michael.nathanson+meta@gmail.com';
const PASSWORD = process.env.REVIEW_PASS ?? '';
const WS = 'e5ac5a8d-6a98-4f24-9c6e-07523811d51e';       // George Harrison Band
const AGENT = '8ee61e3e-5ff9-48d3-996c-4e730fee4c4c';   // George Harrison
const OUT = '/tmp/meta-video';
const RENAME_SENTINEL = '/tmp/meta-rename-done'; // touch after contacts renamed → camera moves to inbox
mkdirSync(OUT, { recursive: true });
rmSync(RENAME_SENTINEL, { force: true });

const ff = spawn('ffmpeg', [
  '-y', '-f', 'avfoundation', '-framerate', '30', '-capture_cursor', '1',
  '-i', '4:none', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast',
  `${OUT}/raw.mp4`,
]);
ff.stderr.on('data', () => {});
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--start-maximized', '--hide-crash-restore-bubble', '--disable-session-crashed-bubble'],
});
const ctx = await browser.newContext({ viewport: null });
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);
const scroll = (dir = 'down', px = 600) =>
  page.evaluate(([d, p]) => window.scrollBy(0, d === 'down' ? p : -p), [dir, px]);

try {
  // 1. timestamp anchor
  await page.goto('https://www.timeanddate.com', { waitUntil: 'domcontentloaded' });
  await wait(5000);

  // 2. landing → privacy policy
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await wait(3000);
  for (let i = 0; i < 6; i++) { await scroll('down', 550); await wait(650); }
  const priv = page.locator('a[href="/privacy"], a:has-text("Privacy")').first();
  if (await priv.count()) { await priv.click(); await page.waitForLoadState('domcontentloaded'); }
  else await page.goto(`${APP}/privacy`, { waitUntil: 'domcontentloaded' });
  await wait(2200);
  for (let i = 0; i < 8; i++) { await scroll('down', 500); await wait(600); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(1200);

  // 3. login — real typed credentials
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await wait(2200);
  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await wait(600);
  await page.fill('input[type="password"]', PASSWORD);
  await wait(600);
  await page.click('button.btn.primary');
  await wait(6000);

  // 4. into the George Harrison Band workspace → agent
  await page.evaluate((w) => fetch('/auth/switch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace_id: w }),
  }), WS);
  await page.goto(`${APP}/agents/${AGENT}`, { waitUntil: 'domcontentloaded' });
  await wait(5000);

  // 5. channels tab → Connect Meta — OPERATOR CLICKS THROUGH OAUTH LIVE
  await page.goto(`${APP}/agents/${AGENT}/configure`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.goto(`${APP}/agents/${AGENT}/channels`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait(3000);
  console.log('>>> PAUSED — click Connect Meta and complete OAuth on camera. Waiting for a meta channel to appear...');
  // wait until a messenger/instagram/whatsapp channel row exists for this agent.
  // No page.reload — the operator is mid-OAuth in this tab; poll silently via fetch.
  for (let i = 0; i < 120; i++) {
    const found = await page.evaluate(async (aid) => {
      const r = await fetch('/api/channels').catch(() => null);
      if (!r || !r.ok) return false;
      const list = await r.json().catch(() => ({}));
      return (list.channels ?? []).some(
        (c) => c.agent_id === aid && ['messenger', 'instagram', 'whatsapp'].includes(c.kind));
    }, AGENT).catch(() => false); // tab may be mid-navigation on facebook.com
    if (found) { console.log('>>> channel connected, resuming'); break; }
    await wait(4000);
  }
  await wait(2000);

  // 6. wait for LIVE inbound on a NEUTRAL page (channels tab — no contact names on
  // screen while the sender's real identity is still in the contact record).
  // Operator sends a Messenger DM, an IG DM, and a WhatsApp text during this beat.
  console.log('>>> send the Messenger DM, IG DM, and WhatsApp text now — waiting for inbound via API (camera stays on channels tab)...');
  for (let i = 0; i < 150; i++) {
    const convoSeen = await page.evaluate(async () => {
      const r = await fetch('/api/conversations').catch(() => null);
      if (!r || !r.ok) return false;
      const j = await r.json().catch(() => ({}));
      const arr = Array.isArray(j) ? j : j.conversations ?? [];
      return arr.length > 0;
    }).catch(() => false);
    if (convoSeen) { console.log('>>> inbound detected'); break; }
    await wait(4000);
  }
  console.log(`>>> PAUSED — rename the new contacts to "Meta Tester", then: touch ${RENAME_SENTINEL}`);
  while (!existsSync(RENAME_SENTINEL)) await wait(1500);

  // 7. inbox tour — every thread shows "Meta Tester", never the real sender
  await page.goto(`${APP}/conversations`, { waitUntil: 'domcontentloaded' });
  await wait(5000);
  const hrefs = await page.locator('a[href*="/conversations/"]')
    .evaluateAll((els) => [...new Set(els.map((a) => a.getAttribute('href')).filter(Boolean))].slice(0, 3));
  for (const h of hrefs) {
    await page.goto(APP + h, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await wait(12000); // dwell — watch the persona reply stream in
    await scroll('down', 400); await wait(3000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(1500);
  }

  // 8. native side — same threads on Meta properties (operator is FB-authed from OAuth).
  //    Sender avatar regions get box-blurred in post.
  await page.goto('https://www.messenger.com', { waitUntil: 'domcontentloaded' });
  await wait(16000); // operator opens the George Harrison Band thread if it doesn't auto-open
  await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait(16000); // operator opens the IG DM thread
  await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait(20000); // operator scans QR (ephemeral) / opens the chat with the test number

  // 8. back to console — channels list as the closer
  await page.goto(`${APP}/agents/${AGENT}/channels`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait(5000);
} catch (e) {
  console.log('FLOW ERR:', e.message);
}

await ctx.close();
await browser.close();
ff.stdin.write('q');
await new Promise((r) => ff.on('close', r));
console.log('raw saved:', `${OUT}/raw.mp4`);
