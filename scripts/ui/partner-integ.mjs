import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const r = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Integrations (optional)');
  if (!h) return 'no-heading';
  let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input,button') && c.innerText.length > 100) break; }
  return {
    text: c.innerText.slice(0, 1200),
    ctrls: [...c.querySelectorAll('input,button,select,textarea')].map(x => ({ t: x.tagName.toLowerCase(), ty: x.type || '', n: x.name || '', ph: x.placeholder || '', x: x.textContent.trim().slice(0, 50), v: x.offsetParent !== null })).filter(x => x.v),
  };
});
console.log(JSON.stringify(r, null, 1));
await page.screenshot({ path: `${OUT}/67-integ.png` });
await ctx.close();
