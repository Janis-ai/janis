import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
// dump feature media card controls
const fm = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Feature media');
  let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input[type="file"]') || c.querySelector('input[type="text"]')) break; }
  return {
    text: c.innerText.slice(0, 800),
    inputs: [...c.querySelectorAll('input,textarea')].map(i => ({ ty: i.type, n: i.name, ph: i.placeholder, v: i.offsetParent !== null, val: i.value?.slice(0, 60) })),
  };
});
console.log(JSON.stringify(fm, null, 1));
await ctx.close();
