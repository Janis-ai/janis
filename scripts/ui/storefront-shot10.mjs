import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://snowboardsareus.myshopify.com', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
if (page.url().includes('/password')) {
  await page.locator('input[type="password"]').first().fill('newtsu');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);
}
await page.waitForSelector('#janis-bubble', { timeout: 90000 });
console.log('bubble found');
const pos = await page.evaluate(() => {
  const r = document.querySelector('#janis-bubble').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(pos.x, pos.y);
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/79-open.png` });
const ta = page.locator('#janis-panel textarea, #janis-panel input[type="text"], textarea').last();
if (await ta.count() && await ta.isVisible()) {
  await ta.click();
  await ta.pressSequentially('What board do you recommend for a beginner?', { delay: 25 });
  await page.keyboard.press('Enter');
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(3000);
    const txt = await page.evaluate(() => document.querySelector('#janis-panel')?.innerText ?? '');
    if (/\$\d|add to cart|recommend/i.test(txt) && txt.length > 300) { console.log('reply at ~', i * 3, 's:', txt.slice(-200)); break; }
  }
}
await page.screenshot({ path: `${OUT}/80-reply.png` });
await browser.close();
