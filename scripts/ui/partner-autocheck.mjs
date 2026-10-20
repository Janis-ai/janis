import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
// click "Run" for automated checks
const runBtn = page.locator('button:has-text("Run")').first();
await runBtn.scrollIntoViewIfNeeded();
await runBtn.click();
await page.waitForTimeout(15000);
await page.screenshot({ path: `${OUT}/56-autocheck.png` });
// inspect the capabilities "Select" control
const cap = await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.includes("Select your app's capabilities"));
  let card = el; for (let i = 0; i < 8 && card; i++) card = card.parentElement;
  return card?.innerText.slice(0, 1500);
});
console.log('CAPABILITIES:', cap);
await ctx.close();
