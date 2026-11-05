import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(400);
const state = async (tag) => console.log(tag, await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const vis = (el) => el && getComputedStyle(el).display !== 'none';
  const layout = q('.conv-layout');
  return JSON.stringify({
    nav: Math.round(q('.sidebar').getBoundingClientRect().width),
    inbox: vis(q('.conv-inbox')) ? Math.round(q('.conv-inbox').getBoundingClientRect().width) : 'X',
    railTight: layout.classList.contains('rail-tight'),
    listTight: layout.classList.contains('list-tight'),
  });
}));
await state('collapsed-auto:');
// expand via the collapse button → rail should drawer
await page.locator('.nav-collapse').first().click();
await page.waitForTimeout(500);
await state('after-expand:');
// collapse back → rail should return
await page.locator('.nav-collapse').first().click();
await page.waitForTimeout(500);
await state('after-collapse:');
await browser.close();
