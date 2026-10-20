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
// conversation persists via visitor token — open panel, messages from earlier run should be there
const pos = await page.evaluate(() => {
  const r = document.querySelector('#janis-bubble').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(pos.x, pos.y);
await page.waitForTimeout(5000);
// scroll the message list to show user question + agent text + top of cards
const scrollInfo = await page.evaluate(() => {
  const cands = [...document.querySelectorAll('#janis-panel *')].filter(e => e.scrollHeight > e.clientHeight + 50);
  const sc = cands.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (!sc) return null;
  const target = Math.max(0, sc.scrollHeight - sc.clientHeight - 320);
  sc.scrollTop = target;
  return { sh: sc.scrollHeight, ch: sc.clientHeight, set: target };
});
console.log('scroll:', JSON.stringify(scrollInfo));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/81-final.png` });
const txt = await page.evaluate(() => document.querySelector('#janis-panel')?.innerText.slice(0, 900));
console.log(txt);
await browser.close();
