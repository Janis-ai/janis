import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const logs = [];
page.on('console', m => { if (m.type() === 'error') logs.push(m.text().slice(0, 140)); });
page.on('response', r => { if (r.url().includes('janis') && r.status() >= 400) logs.push(r.status() + ' ' + r.url().slice(0, 110)); });
let bubble = null;
for (let attempt = 1; attempt <= 5 && !bubble; attempt++) {
  await page.goto('https://snowboardsareus.myshopify.com', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  if (page.url().includes('/password')) {
    await page.locator('input[type="password"]').first().fill('newtsu');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
  }
  for (let i = 0; i < 12 && !bubble; i++) {
    await page.waitForTimeout(5000);
    bubble = await page.evaluate(() => {
      const b = document.querySelector('.janis-bubble');
      if (!b || !b.offsetParent) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
  }
  console.log('attempt', attempt, 'bubble:', JSON.stringify(bubble));
}
console.log('errors:', JSON.stringify(logs));
if (bubble) {
  await page.mouse.click(bubble.x, bubble.y);
  await page.waitForTimeout(4000);
  const ta = page.locator('textarea').last();
  if (await ta.count() && await ta.isVisible()) {
    await ta.click();
    await ta.pressSequentially('What board do you recommend for a beginner?', { delay: 25 });
    await page.keyboard.press('Enter');
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(3000);
      const txt = await page.evaluate(() => document.body.innerText);
      if (/add to cart|\$\d|recommend/i.test(txt.slice(0, 60000))) { console.log('reply landed ~', i * 3, 's'); break; }
    }
  }
  await page.screenshot({ path: `${OUT}/78-reply.png` });
}
await browser.close();
