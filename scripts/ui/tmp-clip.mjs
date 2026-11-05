import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
const probe = async (w, tag) => {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(350);
  console.log(tag || w, await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const vis = (el) => el && getComputedStyle(el).display !== 'none';
    const r = (el) => Math.round(el.getBoundingClientRect().width);
    const cs = q('.conv-side');
    const railRight = cs ? Math.round(cs.getBoundingClientRect().right) : null;
    return `nav=${r(q('.sidebar'))} inbox=${vis(q('.conv-inbox')) ? r(q('.conv-inbox')) : 'X'} main=${r(q('.conv-main'))} railRight=${railRight} win=${innerWidth} clip=${railRight > innerWidth}`;
  }));
};
// expand nav via button, then sweep down through the clip zone
await page.setViewportSize({ width: 1300, height: 900 });
await page.waitForTimeout(400);
await page.locator('.nav-collapse').first().click();
await page.waitForTimeout(400);
for (const w of [1250, 1200, 1150, 1100]) await probe(w);
await browser.close();
