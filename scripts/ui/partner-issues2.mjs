import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const r = await page.evaluate(() => {
  const a = [...document.querySelectorAll('a[href^="#"]')].map(e => ({ t: e.textContent.trim(), h: e.getAttribute('href') })).filter(x => x.t.length > 5 && x.t.length < 200);
  return a;
});
console.log(JSON.stringify(r, null, 1));
await ctx.close();
