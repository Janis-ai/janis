import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const fields = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('input, textarea, select').forEach((el, i) => {
    const wrap = el.closest('fieldset, [class*="field"], div');
    const label = wrap?.querySelector('label')?.textContent?.trim().slice(0, 60) ?? '';
    out.push({ i, tag: el.tagName.toLowerCase(), type: el.type, name: el.name, id: el.id, ph: el.placeholder?.slice(0, 40), label, val: (el.value ?? '').slice(0, 40) });
  });
  return out;
});
console.log(JSON.stringify(fields, null, 1));
// also list left-nav section links
const navs = await page.evaluate(() => [...document.querySelectorAll('nav a, [role="tab"], aside a')].map(a => a.textContent.trim().slice(0, 50) + ' → ' + a.getAttribute('href')));
console.log('NAV:', JSON.stringify(navs, null, 1));
await ctx.close();
