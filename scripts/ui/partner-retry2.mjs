import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(10000);
await page.evaluate(() => {
  const el = [...document.querySelectorAll('button, a')].find(e => e.textContent.trim() === 'Run' && e.offsetParent !== null);
  el?.scrollIntoView();
  el?.click();
});
await page.waitForTimeout(6000);
console.log('run clicked');
// dev store admin
const p2 = await ctx.newPage();
await p2.goto('https://admin.shopify.com/store/snowboardsareus', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await p2.waitForTimeout(12000);
console.log('admin url:', p2.url());
await p2.screenshot({ path: `${OUT}/65-admin.png` });
await ctx.close();
