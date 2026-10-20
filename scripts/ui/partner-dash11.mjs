import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
fs.mkdirSync(OUT, { recursive: true });
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', {
  headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 },
});
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.screenshot({ path: `${OUT}/13-editor-headless.png` });
console.log('url:', page.url());
console.log('title:', await page.title());
await ctx.close();
