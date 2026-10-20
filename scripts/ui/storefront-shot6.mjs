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
await page.waitForSelector('.janis-bubble', { timeout: 90000 });
const pos = await page.evaluate(() => {
  const r = document.querySelector('.janis-bubble').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(pos.x, pos.y);
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/74-open.png` });
const ta = page.locator('.janis-panel textarea, [class*="janis"] textarea, textarea').last();
const n = await ta.count();
console.log('textarea count:', n);
if (n) {
  await ta.scrollIntoViewIfNeeded();
  await ta.click();
  await ta.pressSequentially('What board do you recommend for a beginner?', { delay: 30 });
  await page.keyboard.press('Enter');
  // wait for reply — poll for agent message text
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(3000);
    const txt = await page.evaluate(() => document.querySelector('.janis-panel')?.innerText ?? '');
    if (/recommend|board|beginner|\$|add to cart/i.test(txt) && txt.length > 400) break;
  }
}
await page.screenshot({ path: `${OUT}/75-reply.png` });
console.log('done');
await ctx.close();
