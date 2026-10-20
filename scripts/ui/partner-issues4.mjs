import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const r = await page.evaluate(() => {
  const marker = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.includes('issues to fix'));
  let box = marker;
  for (let i = 0; i < 12 && box; i++) { box = box.parentElement; if (box?.querySelectorAll('li').length >= 2) break; }
  const items = box ? [...box.querySelectorAll('li')].map(li => li.textContent.trim()).filter(Boolean) : [];
  const errs = [...document.querySelectorAll('.Polaris-InlineError, .Polaris-Labelled__Error')].map(e => e.textContent.trim()).filter(Boolean);
  return { items, errs: [...new Set(errs)] };
});
console.log(JSON.stringify(r, null, 1));
await ctx.close();
