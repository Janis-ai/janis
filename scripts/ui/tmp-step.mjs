import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
for (const w of [1400,1500,1300,1200,1100,1050,900,850]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(500);
  console.log(w, await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const vis = (el) => el && getComputedStyle(el).display !== 'none';
    const lay = q('.conv-layout').getBoundingClientRect();
    const side = q('.conv-side');
    const sideVis = vis(side);
    const sideR = sideVis ? Math.round(side.getBoundingClientRect().right) : 0;
    return JSON.stringify({
      nav: Math.round(q('.sidebar').getBoundingClientRect().width), inbox: vis(q('.conv-inbox')) ? Math.round(q('.conv-inbox').getBoundingClientRect().width) : 0,
      conv: Math.round(q('.conv-main').getBoundingClientRect().width),
      side: sideVis ? Math.round(side.getBoundingClientRect().width) : 0,
      clipped: sideVis && sideR > Math.round(lay.right) + 1,
      cls: q('.conv-layout').className.replace('conv-layout', '').trim(),
    });
  }));
}
await browser.close();
