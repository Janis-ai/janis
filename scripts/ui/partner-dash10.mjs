import { chromium } from 'playwright';
import { cookies } from './partner-cookies.mjs';
import fs from 'fs';
const OUT = '/tmp/partner';
fs.mkdirSync(OUT, { recursive: true });
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', {
  headless: false, channel: 'chrome', viewport: { width: 1600, height: 1400 },
});
await ctx.addCookies(cookies);
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);
await page.locator('button:has-text("Complete"), a:has-text("Complete")').first().click().catch(e => console.log('click:', e.message.slice(0, 80)));
await page.waitForTimeout(12000);
await page.screenshot({ path: `${OUT}/11-listing.png` });
console.log('url:', page.url());
// keep browser open 90s in case a human click is needed
await page.waitForTimeout(90000);
await page.screenshot({ path: `${OUT}/12-listing-late.png` });
console.log('late url:', page.url());
await ctx.close();
