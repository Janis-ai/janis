import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/storefront-profile', { headless: true, viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://snowboardsareus.myshopify.com', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
if (page.url().includes('/password')) {
  await page.locator('input[type="password"]').first().fill('newtsu');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);
}
// wait for the bubble element this time
await page.waitForSelector('.janis-bubble', { timeout: 60000 }).catch(() => console.log('bubble never appeared'));
const info = await page.evaluate(() => {
  const b = document.querySelector('.janis-bubble');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
console.log('bubble at:', JSON.stringify(info));
if (info) {
  await page.mouse.click(info.x, info.y);
  await page.waitForTimeout(3500);
  // find the widget's message input
  const inp = await page.evaluate(() => {
    const cands = [...document.querySelectorAll('.janis-panel textarea, .janis-panel input, [class*="janis"] textarea, [class*="janis"] input, textarea, input[type="text"]')].filter(e => e.offsetParent !== null);
    return cands.map(e => ({ cls: e.className?.toString().slice(0, 60), tag: e.tagName }));
  });
  console.log('inputs:', JSON.stringify(inp));
  const ta = page.locator('[class*="janis"] textarea, .janis-panel textarea').first();
  if (await ta.count()) {
    await ta.fill('What board do you recommend for a beginner?');
    await ta.press('Enter');
    await page.waitForTimeout(40000);
  }
  await page.screenshot({ path: `${OUT}/73-reply.png` });
}
await ctx.close();
