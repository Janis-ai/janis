import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/storefront-profile', { headless: true, viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://snowboardsareus.myshopify.com', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
if (page.url().includes('/password')) {
  await page.locator('input[type="password"]').first().fill('newtsu');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);
}
await page.waitForTimeout(40000);
const r = await page.evaluate(() => {
  const r = {};
  r.iframes = [...document.querySelectorAll('iframe')].map(f => ({ src: f.src?.slice(0, 80), id: f.id }));
  r.shadowHosts = [...document.querySelectorAll('*')].filter(e => e.shadowRoot).map(e => e.tagName + '#' + e.id + '.' + e.className?.toString().slice(0, 40));
  // elements near bottom-right corner
  r.corner = [...document.querySelectorAll('body *')].filter(e => {
    const b = e.getBoundingClientRect();
    return e.offsetParent !== null && b.width > 0 && b.right > 1400 && b.bottom > 750;
  }).map(e => e.tagName + '.' + (e.className?.toString() ?? '').slice(0, 50)).slice(0, 20);
  return r;
});
console.log(JSON.stringify(r, null, 1));
await ctx.close();
