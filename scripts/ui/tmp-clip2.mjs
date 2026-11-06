import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.setViewportSize({ width: 1140, height: 900 });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.evaluate(() => window.dispatchEvent(new CustomEvent('janis:open-copilot')));
await page.waitForTimeout(700);
// NOW expand the nav while the dock is already open (the recording's order)
await page.evaluate(() => document.querySelector('.nav-collapse').click());
await page.waitForTimeout(700);
console.log(await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const side = q('.conv-side');
  return JSON.stringify({
    navW: Math.round(q('.sidebar').getBoundingClientRect().width),
    convl: Math.round(q('.conv-layout').clientWidth),
    convW: Math.round(q('.conv-main').getBoundingClientRect().width),
    inboxW: q('.conv-inbox') ? Math.round(q('.conv-inbox').getBoundingClientRect().width) : null,
    side: { d: getComputedStyle(side).display, w: Math.round(side.getBoundingClientRect().width), r: Math.round(side.getBoundingClientRect().right) },
    cls: q('.conv-layout').className, mr: getComputedStyle(q('.main')).marginRight,
    winW: innerWidth,
  });
}));
await browser.close();
