import { chromium } from 'playwright';
import fs from 'fs';

const TOKEN = process.env.SNOW_TOKEN;
if (!TOKEN) { console.error('need SNOW_TOKEN'); process.exit(1); }
const BASE = 'https://app.janis.ai';
const AG = '51a81b16-f6a1-4dfa-ac83-15e116690269';
const CONV = 'aea588c7-8bfa-42f4-b0fa-f69d6e95f5c8';
const OUT = '/tmp/shopify-video3';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir: OUT, size: { width: 1600, height: 900 } } });
await ctx.addInitScript(() => sessionStorage.setItem('janis.pushBanner.dismissed', '1'));
await ctx.addCookies([{ name: 'janis_session', value: TOKEN, domain: 'app.janis.ai', path: '/', secure: true, httpOnly: true }]);
const page = await ctx.newPage();
const log = (s) => console.log(`[${(Date.now() / 1000).toFixed(1)}] ${s}`);

// seg1: overview → channels
await page.goto(`${BASE}/agents/${AG}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(5000);
log('overview');
await page.goto(`${BASE}/agents/${AG}/channels`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);
log('channels');

// seg3: inbox → convo → takeover → reply → resume
await page.goto(`${BASE}/agents/${AG}/inbox`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);
log('inbox');
await page.goto(`${BASE}/agents/${AG}/inbox/${CONV}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(5000);
log('convo');

const takeBtn = page.locator('button:has-text("Take over")').first();
if (await takeBtn.count()) { await takeBtn.click(); await page.waitForTimeout(3000); log('took over'); }
else log('NO TAKEOVER BTN');

const composer = page.locator('textarea').last();
await composer.click().catch(() => {});
await composer.fill("If you're between sizes, the Complete runs a touch large — happy to check the size guide.").catch(() => {});
await page.waitForTimeout(1200);
await page.keyboard.press('Enter');
await page.waitForTimeout(5000);
log('reply sent');

const resumeBtn = page.locator('button:has-text("Resume agent"), button:has-text("Resume")').first();
if (await resumeBtn.count()) { await resumeBtn.click(); await page.waitForTimeout(4000); log('resumed'); }
else log('NO RESUME BTN');
await page.waitForTimeout(3000);

const v = await page.video();
await ctx.close();
await browser.close();
console.log('video:', await v?.path());
