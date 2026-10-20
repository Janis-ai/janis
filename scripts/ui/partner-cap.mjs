import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator('button:has-text("Select")').first().scrollIntoViewIfNeeded();
await page.locator('button:has-text("Select")').first().click();
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/58-capabilities.png` });
const r = await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"], [class*="Modal"], [class*="Sheet"]');
  return dlg ? dlg.innerText.slice(0, 3000) : document.body.innerText.slice(0, 2000);
});
console.log(r);
await ctx.close();
