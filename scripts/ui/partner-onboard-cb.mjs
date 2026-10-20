import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const r = await page.evaluate(() => {
  const l = [...document.querySelectorAll('label')].find(x => x.textContent.includes('detailed onboarding instructions'));
  const cb = l?.querySelector('input[type="checkbox"]');
  if (!cb) return 'no-cb';
  const was = cb.checked;
  if (!was) l.click();
  return { was, now: !was };
});
console.log('onboarding checkbox:', JSON.stringify(r));
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/63-onboard-tick.png` });
await ctx.close();
