import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator('button:has-text("Change"), a:has-text("Change")').first().scrollIntoViewIfNeeded();
await page.locator('button:has-text("Change"), a:has-text("Change")').first().click();
await page.waitForTimeout(4000);
// uncheck Embedded via coordinate click on its checkbox
const r = await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"], [class*="Modal"]') ?? document;
  const l = [...dlg.querySelectorAll('label')].find(x => x.textContent.trim().startsWith('Embedded'));
  const cb = l?.querySelector('input[type="checkbox"]');
  if (!cb) return 'no-cb';
  const rect = cb.getBoundingClientRect();
  return { checked: cb.checked, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
});
console.log('embedded:', JSON.stringify(r));
if (r.checked) await page.mouse.click(r.x, r.y);
await page.waitForTimeout(800);
// confirm via footer button
await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"], [class*="Modal"]') ?? document;
  const b = [...dlg.querySelectorAll('button')].find(x => x.textContent.trim() === 'Show review requirements');
  b?.click();
});
await page.waitForTimeout(6000);
const after = await page.evaluate(() => document.body.innerText.match(/Selected app capabilities:[^\n]*/)?.[0] ?? 'not-found');
console.log('now:', after);
await ctx.close();
