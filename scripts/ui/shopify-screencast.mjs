import { chromium } from 'playwright';
import fs from 'fs';

const TOKEN = process.env.SNOW_TOKEN;
if (!TOKEN) { console.error('need SNOW_TOKEN (minted via scripts/tmp/mint-sb-session.ts)'); process.exit(1); }
const BASE = 'https://app.janis.ai';
const AG = '51a81b16-f6a1-4dfa-ac83-15e116690269';
const CH = 'd7087183-2d86-43f3-bc70-ba24c18cf5a2';
const OUT = '/tmp/shopify-video';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const video = { dir: OUT, size: { width: 1600, height: 900 } };

const consoleCtx = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: video });
await consoleCtx.addInitScript(() => sessionStorage.setItem('janis.pushBanner.dismissed', '1'));
await consoleCtx.addCookies([{ name: 'janis_session', value: TOKEN, domain: 'app.janis.ai', path: '/', secure: true, httpOnly: true }]);
const console_ = await consoleCtx.newPage();

const visitorCtx = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: video });
const visitor = await visitorCtx.newPage();

const log = (s) => console.log(`[${(Date.now() / 1000).toFixed(1)}] ${s}`);

// --- console: agent overview showcase
await console_.goto(`${BASE}/agents/${AG}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await console_.waitForTimeout(4000);
log('console overview shown');

// --- console: channels tab
await console_.goto(`${BASE}/agents/${AG}/channels`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await console_.waitForTimeout(5000);
log('channels shown');

// --- visitor: open chat, wait for greeting
await visitor.goto(`${BASE}/chat/${CH}/page?mode=full`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await visitor.waitForTimeout(6000);
log('visitor page loaded');

// --- visitor: send a shopper message
const input = visitor.locator('textarea, input[type="text"]').last();
await input.click();
await input.fill("Hi! I'm a beginner looking for my first snowboard setup — what do you recommend?");
log('visitor typed');
await visitor.keyboard.press('Enter');
log('visitor sent');

// wait for the agent reply to appear (poll for assistant bubble)
for (let i = 0; i < 60; i++) {
  const txt = await visitor.evaluate(() => document.body.innerText.length);
  if (txt > 800) break;
  await visitor.waitForTimeout(1000);
}
await visitor.waitForTimeout(6000);
log('visitor reply window done');

// --- console: inbox, find the fresh conversation, take over, human reply, resume
await console_.goto(`${BASE}/agents/${AG}/inbox`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await console_.waitForTimeout(4000);
log('inbox loaded');
// open the newest conversation (first row)
await console_.locator('main >> table tbody tr, main [role="row"], main a, main button').first().click().catch(() => {});
await console_.waitForTimeout(4000);
log('convo opened: ' + console_.url());
// take over
const takeBtn = console_.locator('button:has-text("Take over"), button:has-text("Take Over")').first();
if (await takeBtn.count()) { await takeBtn.click(); await console_.waitForTimeout(3000); log('took over'); }
// human reply
const composer = console_.locator('textarea').last();
await composer.click();
await composer.fill("Hey — this is Maya from the shop, hopping in to help with sizing. What height and boot size are you?");
await console_.waitForTimeout(800);
await console_.keyboard.press('Enter');
await console_.waitForTimeout(4000);
log('human reply sent');
// resume agent
const resumeBtn = console_.locator('button:has-text("Resume agent"), button:has-text("Resume")').first();
if (await resumeBtn.count()) { await resumeBtn.click(); await console_.waitForTimeout(3000); log('resumed'); }

// --- visitor: show the human reply landed
await visitor.bringToFront();
await visitor.waitForTimeout(6000);
log('visitor tail done');

const v1 = await console_.video();
const v2 = await visitor.video();
await consoleCtx.close();
await visitorCtx.close();
await browser.close();
console.log('console video:', await v1?.path());
console.log('visitor video:', await v2?.path());
