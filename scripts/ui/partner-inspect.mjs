import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const dump = async (label, sel) => {
  const r = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const inputs = [...el.querySelectorAll('input, textarea, select, button')].map(i => ({
      tag: i.tagName.toLowerCase(), type: i.type || '', name: i.name || '', id: i.id || '',
      ph: i.placeholder || '', txt: (i.textContent || '').trim().slice(0, 60), dis: i.disabled, vis: i.offsetParent !== null,
    }));
    return { text: el.innerText.slice(0, 900), inputs };
  }, sel);
  console.log(`=== ${label} (${sel}) ===`);
  console.log(JSON.stringify(r, null, 1).slice(0, 4000));
};
// find section containers by heading text
const secs = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('h1,h2,h3,legend,[class*="Heading"]')].map(h => h.textContent.trim());
  return heads;
});
console.log('HEADINGS:', JSON.stringify(secs));
await dump('languages', '.param-multi-select-languages');
await ctx.close();
