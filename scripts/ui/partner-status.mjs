import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/54-top.png` });
const r = await page.evaluate(() => {
  const errs = [...document.querySelectorAll('.Polaris-InlineError, .Polaris-Labelled__Error')].map(e => e.textContent.trim()).filter(Boolean);
  const banner = document.body.innerText.match(/\d+ issues?/)?.[0] ?? 'none';
  const submitBtns = [...document.querySelectorAll('button, a')].filter(e => /submit|review/i.test(e.textContent) && e.offsetParent !== null).map(e => e.textContent.trim().slice(0, 60));
  const topText = document.body.innerText.split('\n').slice(0, 30).filter(Boolean);
  return { banner, errs: [...new Set(errs)], submitBtns, topText };
});
console.log(JSON.stringify(r, null, 1));
await ctx.close();
