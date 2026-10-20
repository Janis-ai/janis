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
await page.waitForTimeout(3000);
const pos = await page.evaluate(() => {
  const r = document.querySelector('#janis-bubble').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(pos.x, pos.y);
await page.waitForTimeout(4000);
const ta = page.locator('#janis-panel textarea, textarea').last();
await ta.click();
await ta.pressSequentially('What board do you recommend for a beginner?', { delay: 25 });
await page.keyboard.press('Enter');
// wait for the product carousel to render
await page.waitForFunction(() => /add to cart/i.test(document.querySelector('#janis-panel')?.innerText ?? ''), null, { timeout: 120000 }).catch(() => console.log('no carousel'));
await page.waitForTimeout(3000);
// scroll the message list so question + reply text + card tops are visible
const scroll = await page.evaluate(() => {
  const cands = [...document.querySelectorAll('#janis-panel *')].filter(e => e.scrollHeight > e.clientHeight + 30);
  const sc = cands.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (!sc) return null;
  sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - 420);
  return { sh: sc.scrollHeight, set: sc.scrollTop };
});
console.log('scroll:', JSON.stringify(scroll));
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/82-final.png` });
await browser.close();
