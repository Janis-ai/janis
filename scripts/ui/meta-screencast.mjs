// Meta Platform Term 7.a screencast — records REAL headed Chrome (URL bar
// + menu-bar clock visible) while Playwright drives the flow, ffmpeg captures
// the screen via avfoundation. Output: /tmp/meta-video/raw.mp4 → overlay
// annotation + faststart → docs/listing-assets/meta-7a-screencast.mp4
//   node scripts/ui/meta-screencast.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const APP = 'https://app.janis.ai';
const EMAIL = 'meta-review@janis.ai';
const PASSWORD = process.env.REVIEW_PASS ?? '';
const WS_MIKE = 'acd296f3-61e1-46c5-ae57-6cdbddbdca85';   // Michael's workspace (the one with agents)
const WS_MOOK = 'e644e996-8683-40a3-a19e-eff4023c7191';   // mook mook's workspace (WhatsApp)
const CONV_MSG = '8d8dfcb1-0b46-4ac1-9acb-7e056eb1e9da'; // Janis Demos messenger convo
const WA_AGENT = '381e93a2-f0e5-4b01-b78a-ee2120ff75f2'; // FB Integration Advisor
const WA_CHAN = 'e3a84536-e8f6-4cec-8d71-9767ad02e9c4';  // +1 555-163-0987
const OUT = '/tmp/meta-video';
mkdirSync(OUT, { recursive: true });

// --- screen capture ---------------------------------------------------------
const ff = spawn('ffmpeg', [
  '-y', '-f', 'avfoundation', '-framerate', '30', '-capture_cursor', '1',
  '-i', '4:none', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast',
  `${OUT}/raw.mp4`,
]);
ff.stderr.on('data', () => {});
await new Promise((r) => setTimeout(r, 2500)); // let ffmpeg spin up

// --- headed chrome ------------------------------------------------------------
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--start-maximized', '--hide-crash-restore-bubble', '--disable-session-crashed-bubble'],
});
const ctx = await browser.newContext({ viewport: null });
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);
const scroll = async (dir = 'down', px = 600) =>
  page.evaluate(([d, p]) => window.scrollBy(0, d === 'down' ? p : -p), [dir, px]);
const switchWs = async (wsId) => {
  await page.evaluate((w) => fetch('/auth/switch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace_id: w }),
  }), wsId);
};

try {
  // 1. time + date — reliable external timestamp, plus the menu-bar clock all along
  await page.goto('https://www.timeanddate.com', { waitUntil: 'domcontentloaded' });
  await wait(5000);

  // 2. landing → privacy policy (location of the policy inside the app)
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await wait(3500);
  for (let i = 0; i < 6; i++) { await scroll('down', 550); await wait(700); }
  const priv = page.locator('a[href="/privacy"], a:has-text("Privacy")').first();
  if (await priv.count()) { await priv.click(); await page.waitForLoadState('domcontentloaded'); }
  else await page.goto(`${APP}/privacy`, { waitUntil: 'domcontentloaded' });
  await wait(2500);
  for (let i = 0; i < 8; i++) { await scroll('down', 500); await wait(650); } // scroll the policy
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(1500);

  // 3. login flow — email/password, real typed credentials
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await wait(2500);
  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await wait(600);
  await page.fill('input[type="password"]', PASSWORD);
  await wait(600);
  await page.click('button.btn.primary');
  await page.waitForURL(/conversations|agents|welcome|\//, { timeout: 20000 }).catch(() => {});
  await wait(6000);

  // land on Michael's workspace — where the live Meta channels are
  await switchWs(WS_MIKE);
  await page.goto(`${APP}/conversations`, { waitUntil: 'domcontentloaded' });
  await wait(5000);
  await page.click('.push-banner-dismiss').catch(() => {});

  // 4. messenger permission in use — open a live Messenger thread
  await page.goto(`${APP}/conversations/${CONV_MSG}`, { waitUntil: 'domcontentloaded' });
  await wait(4500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(1200);
  for (let i = 0; i < 3; i++) { await scroll('down', 450); await wait(800); }
  // real reply → proves write access over pages_messaging
  const composer = page.locator('textarea').last();
  if (await composer.count()) {
    await composer.click();
    await composer.fill('This reply is being sent from the Janis console via the Messenger integration.');
    await wait(1200);
    await page.keyboard.press('Enter').catch(() => {});
    await page.locator('button:has-text("Send")').first().click().catch(() => {});
    await wait(3500);
  }

  // 5. agent overview — the agent serving that channel
  await page.goto(`${APP}/agents`, { waitUntil: 'domcontentloaded' });
  await wait(3500);
  const janisAgent = page.locator('a[href*="/agents/"]:has-text("Janis")').first();
  if (await janisAgent.count()) { await janisAgent.click(); await wait(4000); }

  // 6. whatsapp channel — mook mook's workspace, connected WABA number
  await switchWs(WS_MOOK);
  await page.goto(`${APP}/agents/${WA_AGENT}/channels/${WA_CHAN}`, { waitUntil: 'domcontentloaded' });
  await wait(5000);
  await page.screenshot({ path: `${OUT}/wa-channel.png` });

  // back to inbox for the tail
  await page.goto(`${APP}/conversations`, { waitUntil: 'domcontentloaded' });
  await wait(4000);
} catch (e) {
  console.log('FLOW ERR:', e.message);
}

await ctx.close();
await browser.close();
ff.stdin.write('q'); // clean mp4 finalize
await new Promise((r) => ff.on('close', r));
console.log('raw saved:', `${OUT}/raw.mp4`);
