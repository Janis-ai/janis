// Meta 7.a screencast — TAKE 2. Records the second monitor (avfoundation '5')
// so nothing on the main display can occlude the take. Channels are already
// linked; this shoots login → connected channels → inbox threads → human
// takeover → native-side threads (messenger.com / IG direct / WA web).
//
//   REVIEW_PASS=<pw> node scripts/ui/meta-screencast-2.mjs
//
// Manual beats pause on sentinel files — the operator acts on camera, tells
// Devin "next", and Devin runs `touch /tmp/meta-gate-N` to release.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';

const APP = 'https://app.janis.ai';
const EMAIL = 'michael.nathanson+meta@gmail.com';
const PASSWORD = process.env.REVIEW_PASS ?? '';
const WS = 'e5ac5a8d-6a98-4f24-9c6e-07523811d51e';
const AGENT = '8ee61e3e-5ff9-48d3-996c-4e730fee4c4c';
const PROFILE = '/tmp/meta-chrome-profile'; // persistent — Meta/WA logins survive retakes
const OUT = '/tmp/meta-video2';
mkdirSync(OUT, { recursive: true });
const gate = async (n, msg, wait) => {
  console.log(msg);
  const f = `/tmp/meta-gate-${n}`;
  rmSync(f, { force: true });
  while (!existsSync(f)) await wait(1200);
  console.log(`>>> gate ${n} released`);
};
for (const n of [1, 2, 3]) rmSync(`/tmp/meta-gate-${n}`, { force: true });

const ff = spawn('ffmpeg', [
  '-y', '-f', 'avfoundation', '-framerate', '30', '-capture_cursor', '1',
  '-i', '5:none', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast',
  `${OUT}/raw.mp4`,
]);
ff.stderr.on('data', () => {});
await new Promise((r) => setTimeout(r, 2500));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false,
  args: ['--test-type', '--hide-crash-restore-bubble', '--disable-session-crashed-bubble'],
  viewport: null,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const wait = (ms) => page.waitForTimeout(ms);
const scroll = (dir = 'down', px = 600) =>
  page.evaluate(([d, p]) => window.scrollBy(0, d === 'down' ? p : -p), [dir, px]).catch(() => {});

// Park the window on monitor 2 — top-left-down screen coords: x=2560, y=1437, 2056x1329
const cdp = await ctx.newCDPSession(page);
const { windowId } = await cdp.send('Browser.getWindowForTarget');
await cdp.send('Browser.setWindowBounds', {
  windowId,
  bounds: { windowState: 'normal', left: 2560, top: 1437, width: 2056, height: 1329 },
});

try {
  // 1. login — real typed credentials
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await wait(2500);
  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await wait(700);
  await page.fill('input[type="password"]', PASSWORD);
  await wait(700);
  await page.click('button.btn.primary');
  await wait(6000);

  // 2. workspace → George Harrison agent → channels: all three Meta channels connected
  await page.evaluate((w) => fetch('/auth/switch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace_id: w }),
  }), WS).catch(() => {});
  await page.goto(`${APP}/agents/${AGENT}/channels`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait(6000);
  await scroll('down', 500); await wait(2000);
  await page.evaluate(() => window.scrollTo(0, 0)); await wait(1500);

  // 3. inbox — three tester threads, tour each
  await page.goto(`${APP}/conversations`, { waitUntil: 'domcontentloaded' });
  await wait(5000);
  await page.click('button[aria-label="Dismiss onboarding checklist"]').catch(() => {});
  // wait until at least one thread row rendered
  for (let i = 0; i < 15; i++) {
    if (await page.locator('a[href*="/conversations/"]').count()) break;
    await wait(1000);
  }
  await wait(2000);
  const hrefs = await page.locator('a[href*="/conversations/"]')
    .evaluateAll((els) => [...new Set(els.map((a) => a.getAttribute('href')).filter(Boolean))].slice(0, 3));

  // pick the messenger thread for the takeover beat — channel kind rides on external_id
  const messengerConvo = await page.evaluate(async () => {
    const cv = await fetch('/api/conversations').then((r) => r.json()).catch(() => ({}));
    const conv = (cv.conversations ?? []).find((c) => (c.external_id ?? '').startsWith('messenger:'));
    return conv?.id ?? null;
  }).catch(() => null);
  console.log('messenger convo for takeover:', messengerConvo);

  for (const h of hrefs) {
    const id = h.split('/conversations/')[1];
    const isMessenger = id === messengerConvo;
    await page.goto(APP + h, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await wait(8000);
    await scroll('down', 400); await wait(2500);
    await page.evaluate(() => window.scrollTo(0, 0)); await wait(1000);

    if (isMessenger) {
      // 4. HUMAN TAKEOVER on the messenger thread
      const btn = page.locator('button:has-text("Take over")');
      if (await btn.count()) {
        await btn.first().click();
        await wait(2500);
        const ta = page.locator('textarea[placeholder^="Reply as a human"]');
        if (await ta.count()) {
          await ta.fill("Hi! Human teammate jumping in for a moment — George will take it from here again in a sec.");
          await wait(1800);
          await ta.press('Enter');
          await wait(9000); // the reply travels to the visitor's Messenger thread
        }
        const resume = page.locator('button:has-text("Resume agent")');
        if (await resume.count()) { await resume.first().click(); await wait(3000); }
      }
    }
    await wait(1500);
  }

  // 5. native side — deep links captured in warm-up; sessions already live.
  //    Left rails show real contacts → box-blur the rail in post.
  await page.goto('https://www.messenger.com/t/341629853024984', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait(6000);
  // if Meta bounced to login, hold for the operator to sign in on camera
  if (await page.locator('input[name="email"], button:has-text("Continue")').count().catch(() => 0)) {
    await gate(1, '>>> messenger.com needs login — sign in (check "Keep me signed in"), open the George harrison band thread, then "next"', wait);
  }
  await wait(10000);
  await scroll('down', 300); await wait(3000);

  await page.goto('https://www.instagram.com/direct/t/17852980502612560/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait(14000);

  await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait(12000);
  // chat list: open the 555-number conversation if it isn't restored already
  const waChat = page.locator('span[title*="555"], span[title*="Test Number"]').first();
  if (await waChat.count().catch(() => 0)) await waChat.click().catch(() => {});
  else await gate(3, '>>> web.whatsapp.com — open the +1 555-163-0987 chat, then tell Devin "next"', wait);
  await wait(10000);

  // 6. closer — channels list
  await page.goto(`${APP}/agents/${AGENT}/channels`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait(6000);
} catch (e) {
  console.log('FLOW ERR:', e.message);
}

await ctx.close();
ff.stdin.write('q');
await new Promise((r) => ff.on('close', r));
console.log('raw saved:', `${OUT}/raw.mp4`);
