import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const chatReady = page.waitForResponse(r => r.url().includes('app.janis.ai/chat/') && r.url().includes('/messages'), { timeout: 90000 }).catch(() => null);
await page.goto('https://snowboardsareus.myshopify.com', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
if (page.url().includes('/password')) {
  await page.locator('input[type="password"]').first().fill('newtsu');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);
}
await chatReady;
await page.waitForTimeout(6000);
const els = await page.evaluate(() => [...document.querySelectorAll('[class*="janis"]')].filter(e => e.offsetParent !== null).map(e => {
  const r = e.getBoundingClientRect();
  return { tag: e.tagName, cls: e.className?.toString().slice(0, 50), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}));
console.log('janis els:', JSON.stringify(els.slice(0, 12)));
// click the bubble
const bub = els.find(e => e.cls.includes('bubble')) ?? els[0];
if (bub) {
  await page.mouse.click(bub.x, bub.y);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/77-open.png` });
  const ta = page.locator('textarea').last();
  if (await ta.count() && await ta.isVisible()) {
    await ta.click();
    await ta.pressSequentially('What board do you recommend for a beginner?', { delay: 25 });
    await page.keyboard.press('Enter');
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(3000);
      const txt = await page.evaluate(() => document.querySelector('[class*="panel"], [class*="chat"]')?.innerText ?? '');
      if (/\$\d|add to cart|recommend/i.test(txt) && txt.length > 300) { console.log('reply at', i * 3, 's'); break; }
    }
  }
  await page.screenshot({ path: `${OUT}/78-reply.png` });
}
await browser.close();
