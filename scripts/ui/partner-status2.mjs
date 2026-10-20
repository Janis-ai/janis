import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(10000);
const r = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')].map(c => ({
    t: (c.closest('label')?.textContent ?? '').trim().slice(0, 80), chk: c.checked,
  }));
  const checks = document.body.innerText.match(/(check|error|fail|pass)[^\n]{0,80}/gi)?.slice(0, 15);
  return { boxes, checks };
});
console.log(JSON.stringify(r, null, 1));
await ctx.close();
