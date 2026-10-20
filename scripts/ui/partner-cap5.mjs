import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator('button:has-text("Change"), a:has-text("Change")').first().scrollIntoViewIfNeeded();
await page.locator('button:has-text("Change"), a:has-text("Change")').first().click();
await page.waitForTimeout(4000);
const r = await page.evaluate(() => {
  const cbs = [...document.querySelectorAll('input[type="checkbox"]')];
  return cbs.map(c => {
    let lab = c.closest('label') ?? document.querySelector(`label[for="${c.id}"]`) ?? c.parentElement;
    const rect = c.getBoundingClientRect();
    return { id: c.id, chk: c.checked, vis: c.offsetParent !== null, w: rect.width, x: rect.x, y: rect.y, near: lab?.textContent?.trim().slice(0, 50) };
  }).filter(c => c.vis || c.w > 0);
});
console.log(JSON.stringify(r, null, 1));
await ctx.close();
