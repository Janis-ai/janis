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
// wait for widget — find the chat button regardless of class
await page.waitForTimeout(45000);
const found = await page.evaluate(() => {
  const els = [...document.querySelectorAll('button, [role="button"], div')].filter(e => {
    const r = e.getBoundingClientRect();
    return r.width > 30 && r.width < 100 && r.bottom > window.innerHeight - 130 && r.right > window.innerWidth - 130 && e.offsetParent !== null;
  });
  const el = els[els.length - 1];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, cls: el.className?.toString().slice(0, 60) };
});
console.log('bubble:', JSON.stringify(found));
if (found) {
  await page.mouse.click(found.x, found.y);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/72-open.png` });
  // type a shopper question
  const ta = await page.locator('textarea, input[type="text"]').last();
  if (await ta.count()) {
    await ta.fill('What board do you recommend for a beginner?');
    await page.keyboard.press('Enter');
    // wait for the reply to render
    await page.waitForTimeout(25000);
    await page.waitForTimeout(15000);
  }
  await page.screenshot({ path: `${OUT}/73-reply.png` });
}
await ctx.close();
