import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.evaluate(() => window.dispatchEvent(new CustomEvent('janis:open-copilot')));
await page.waitForTimeout(600);
for (const w of [1300, 1000, 900, 800]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(400);
  console.log(w, await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const m = q('.main');
    const dock = q('.dock');
    const dockL = dock ? Math.round(dock.getBoundingClientRect().left) : null;
    const info = q('.cmh-info:not(.cmh-copilot)');
    const infoR = info && getComputedStyle(info).display !== 'none' ? Math.round(info.getBoundingClientRect().right) : null;
    return JSON.stringify({ mainW: Math.round(m.getBoundingClientRect().width), mr: getComputedStyle(m).marginRight, dockL, infoR, covered: infoR && dockL ? infoR > dockL : null });
  }));
}
await browser.close();
