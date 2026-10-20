import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(10000);
const box = await page.evaluate(() => {
  const l = [...document.querySelectorAll('label')].find(x => x.textContent.includes('detailed onboarding instructions'));
  const r = l?.getBoundingClientRect();
  return r ? { x: r.x + 12, y: r.y + 12 } : null;
});
console.log('box:', JSON.stringify(box));
if (box) { await page.mouse.click(box.x, box.y); }
await page.waitForTimeout(2500);
// reload and verify persistence
await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(9000);
const after = await page.evaluate(() => {
  const l = [...document.querySelectorAll('label')].find(x => x.textContent.includes('detailed onboarding instructions'));
  return l?.querySelector('input[type="checkbox"]')?.checked;
});
console.log('persisted:', after);
await ctx.close();
