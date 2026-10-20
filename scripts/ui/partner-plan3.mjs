import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/pricing/bbc74ee5092894c6b45e93e24db1ede6', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const r = await page.evaluate(() => {
  const frames = [...document.querySelectorAll('iframe')].map(f => f.src);
  // find all clickable things with 'Add' text including shadow hosts
  const allBtns = [...document.querySelectorAll('button, a, [role="button"], span, div')].filter(e =>
    e.children.length === 0 && e.textContent.trim() === 'Add');
  const shadowHosts = [...document.querySelectorAll('*')].filter(e => e.shadowRoot).map(e => e.tagName);
  return { frames, addEls: allBtns.map(e => ({ tag: e.tagName, role: e.getAttribute('role'), vis: e.offsetParent !== null })), shadowHosts: [...new Set(shadowHosts)] };
});
console.log(JSON.stringify(r, null, 1));
console.log('frames count:', page.frames().length);
for (const f of page.frames()) console.log('frame:', f.url());
await ctx.close();
