import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator('button:has-text("Change"), a:has-text("Change")').first().scrollIntoViewIfNeeded();
await page.locator('button:has-text("Change"), a:has-text("Change")').first().click();
await page.waitForTimeout(4000);
// check current state of each capability checkbox
const state = await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"], [class*="Modal"]') ?? document;
  return [...dlg.querySelectorAll('label')].filter(l => l.querySelector('input[type="checkbox"]')).map(l => ({
    t: l.textContent.trim().slice(0, 40), chk: l.querySelector('input').checked,
  }));
});
console.log(JSON.stringify(state));
await page.screenshot({ path: `${OUT}/60-cap-dialog.png` });
// uncheck Embedded if checked
await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"], [class*="Modal"]') ?? document;
  const l = [...dlg.querySelectorAll('label')].find(x => x.textContent.trim().startsWith('Embedded'));
  const cb = l?.querySelector('input[type="checkbox"]');
  if (cb && cb.checked) l.click();
});
await page.waitForTimeout(800);
await page.locator('button:has-text("Show review requirements"), button:has-text("Save"), button:has-text("Done")').first().click();
await page.waitForTimeout(6000);
const after = await page.evaluate(() => document.body.innerText.match(/Selected app capabilities:[^\n]*/)?.[0]);
console.log('now:', after);
await ctx.close();
