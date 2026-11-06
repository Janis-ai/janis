import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.setViewportSize({ width: 1000, height: 900 });
await page.waitForTimeout(400);
await page.evaluate(() => window.dispatchEvent(new CustomEvent('janis:open-copilot')));
await page.waitForTimeout(700);
console.log(await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const vis = (el) => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
  const r = (el) => el ? { l: Math.round(el.getBoundingClientRect().left), r: Math.round(el.getBoundingClientRect().right), d: getComputedStyle(el).display } : null;
  const info = q('.cmh-info:not(.cmh-copilot)');
  const side = q('.conv-side');
  const scrim = q('.conv-side-scrim');
  return JSON.stringify({
    convW: Math.round(q('.conv-main').getBoundingClientRect().width),
    inbox: vis(q('.conv-inbox')),
    side: r(side), scrim: Boolean(scrim),
    info: r(info),
    dockL: Math.round(q('.dock').getBoundingClientRect().left),
    cls: q('.conv-layout').className,
  });
}));
await page.screenshot({ path: 'scripts/ui/out/still.png', clip: { x: 0, y: 0, width: 1000, height: 120 } });
await browser.close();
