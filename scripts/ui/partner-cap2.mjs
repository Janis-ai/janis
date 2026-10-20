import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator('button:has-text("Select")').first().scrollIntoViewIfNeeded();
await page.locator('button:has-text("Select")').first().click();
await page.waitForTimeout(4000);
// check "Online store"
await page.evaluate(() => {
  const l = [...document.querySelectorAll('label')].find(x => x.textContent.trim().startsWith('Online store'));
  const cb = l?.querySelector('input[type="checkbox"]');
  if (cb && !cb.checked) l.click();
});
await page.waitForTimeout(1000);
await page.locator('button:has-text("Show review requirements"), button:has-text("Save")').first().click();
await page.waitForTimeout(8000);
await page.screenshot({ path: `${OUT}/59-cap-done.png` });
const txt = await page.evaluate(() => document.body.innerText.slice(0, 3500));
console.log(txt);
await ctx.close();
