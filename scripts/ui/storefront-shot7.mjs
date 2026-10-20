import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/storefront-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const chatReady = page.waitForResponse(r => r.url().includes('app.janis.ai/chat/') && r.url().includes('/messages'), { timeout: 90000 }).catch(() => null);
await page.goto('https://snowboardsareus.myshopify.com', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
if (page.url().includes('/password')) {
  await page.locator('input[type="password"]').first().fill('newtsu');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);
}
await chatReady;
await page.waitForTimeout(5000);
// dump all janis elements with visibility + position
const els = await page.evaluate(() => [...document.querySelectorAll('[class*="janis"]')].map(e => {
  const r = e.getBoundingClientRect();
  return { tag: e.tagName, cls: e.className?.toString().slice(0, 60), vis: e.offsetParent !== null, w: Math.round(r.width), x: Math.round(r.x), y: Math.round(r.y) };
}));
console.log(JSON.stringify(els.filter(e => e.vis || e.w > 0), null, 1));
await page.screenshot({ path: `${OUT}/76-state.png` });
await ctx.close();
