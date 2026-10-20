import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(10000);
// is it disabled?
const st = await page.evaluate(() => {
  const l = [...document.querySelectorAll('label')].find(x => x.textContent.includes('detailed onboarding instructions'));
  const cb = l?.querySelector('input[type="checkbox"]');
  return { dis: cb?.disabled, aria: cb?.getAttribute('aria-disabled'), chk: cb?.checked };
});
console.log('state:', JSON.stringify(st));
// focus the input directly and press Space
await page.evaluate(() => {
  const l = [...document.querySelectorAll('label')].find(x => x.textContent.includes('detailed onboarding instructions'));
  l?.querySelector('input[type="checkbox"]')?.focus();
});
await page.waitForTimeout(400);
await page.keyboard.press('Space');
await page.waitForTimeout(2000);
const after1 = await page.evaluate(() => {
  const l = [...document.querySelectorAll('label')].find(x => x.textContent.includes('detailed onboarding instructions'));
  return l?.querySelector('input[type="checkbox"]')?.checked;
});
console.log('immediately:', after1);
await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(9000);
const after2 = await page.evaluate(() => {
  const l = [...document.querySelectorAll('label')].find(x => x.textContent.includes('detailed onboarding instructions'));
  return l?.querySelector('input[type="checkbox"]')?.checked;
});
console.log('persisted:', after2);
await ctx.close();
