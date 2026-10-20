import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator('button:has-text("Run")').first().scrollIntoViewIfNeeded();
await page.locator('button:has-text("Run")').first().click();
await page.waitForTimeout(8000);
console.log('check re-triggered');
// try dev store admin with the same profile
const p2 = await ctx.newPage();
await p2.goto('https://admin.shopify.com/store/snowboardsareus', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await p2.waitForTimeout(10000);
console.log('admin url:', p2.url());
await p2.screenshot({ path: `${OUT}/65-admin.png` });
await ctx.close();
