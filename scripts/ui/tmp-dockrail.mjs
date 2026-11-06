import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.setViewportSize({ width: 1300, height: 900 });
await page.waitForTimeout(400);
// open copilot dock
await page.evaluate(() => window.dispatchEvent(new CustomEvent('janis:open-copilot')));
await page.waitForTimeout(600);
const st = async (tag) => console.log(tag, await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const vis = (el) => el && getComputedStyle(el).display !== 'none';
  const info = q('.conv-mobile-head .cmh-info:not(.cmh-copilot)');
  return JSON.stringify({
    dockOpen: q('.layout').classList.contains('dock-open'),
    railTight: q('.conv-layout')?.classList.contains('rail-tight'),
    infoVis: vis(info),
    inbox: vis(q('.conv-inbox')) ? Math.round(q('.conv-inbox').getBoundingClientRect().width) : 'X',
  });
}));
await st('dock-open:');
for (const w of [1100, 950, 800]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(400);
  await st(`${w}:`);
}
await browser.close();
