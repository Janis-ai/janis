import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const r = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Integrations (optional)');
  let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.innerText.includes('/6') || c.innerText.length > 200) break; }
  return c.innerText.slice(0, 600);
});
console.log(r);
await ctx.close();
