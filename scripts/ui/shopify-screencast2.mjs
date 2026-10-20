import { chromium } from 'playwright';
import fs from 'fs';

const TOKEN = process.env.SNOW_TOKEN;
if (!TOKEN) { console.error('need SNOW_TOKEN (minted via scripts/tmp/mint-sb-session.ts)'); process.exit(1); }
const BASE = 'https://app.janis.ai';
const AG = '51a81b16-f6a1-4dfa-ac83-15e116690269';
const CONV = 'aea588c7-8bfa-42f4-b0fa-f69d6e95f5c8';
const OUT = '/tmp/shopify-video2';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir: OUT, size: { width: 1600, height: 900 } } });
await ctx.addInitScript(() => sessionStorage.setItem('janis.pushBanner.dismissed', '1'));
await ctx.addCookies([{ name: 'janis_session', value: TOKEN, domain: 'app.janis.ai', path: '/', secure: true, httpOnly: true }]);
const page = await ctx.newPage();
const log = (s) => console.log(`[${(Date.now() / 1000).toFixed(1)}] ${s}`);

// inbox with the fresh conversation visible at top
await page.goto(`${BASE}/agents/${AG}/inbox`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);
log('inbox');

// open the new conversation directly
await page.goto(`${BASE}/agents/${AG}/inbox/${CONV}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(5000);
log('convo: ' + page.url());

// take over
const takeBtn = page.locator('button:has-text("Take over"), button:has-text("Take Over")').first();
if (await takeBtn.count()) {
  await takeBtn.click();
  await page.waitForTimeout(3000);
  log('took over');
} else log('NO TAKEOVER BUTTON');

// human reply
const composer = page.locator('textarea').last();
await composer.click().catch(() => {});
await composer.fill("Hey — Maya from the shop here, hopping in to help with sizing. What height and boot size are you?").catch(() => {});
await page.waitForTimeout(1000);
await page.keyboard.press('Enter');
await page.waitForTimeout(5000);
log('human reply sent');

// resume agent
const resumeBtn = page.locator('button:has-text("Resume agent"), button:has-text("Resume")').first();
if (await resumeBtn.count()) {
  await resumeBtn.click();
  await page.waitForTimeout(3000);
  log('resumed');
} else log('NO RESUME BUTTON');

await page.waitForTimeout(4000);
const v = await page.video();
await ctx.close();
await browser.close();
console.log('video:', await v?.path());
