import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
for (const w of [900, 850, 816, 800]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(450);
  console.log(w, await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const vis = (el) => el && getComputedStyle(el).display !== 'none';
    return JSON.stringify({
      nav: Math.round(q('.sidebar').getBoundingClientRect().width),
      inbox: vis(q('.conv-inbox')) ? Math.round(q('.conv-inbox').getBoundingClientRect().width) : 0,
      conv: Math.round(q('.conv-main').getBoundingClientRect().width),
      side: vis(q('.conv-side')) ? Math.round(q('.conv-side').getBoundingClientRect().width) : 0,
    });
  }));
}
await browser.close();
