import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const [popup] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null),
  page.locator('button:has-text("Preview listing")').click(),
]);
await page.waitForTimeout(6000);
const target = popup ?? page;
await target.waitForTimeout(4000);
console.log('preview url:', target.url());
await target.screenshot({ path: `${OUT}/66-preview.png`, fullPage: false });
await ctx.close();
