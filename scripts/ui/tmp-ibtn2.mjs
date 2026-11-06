import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
const st = async (t) => console.log(t, await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const side = q('.conv-side');
  const info = q('.conv-mobile-head .cmh-info:not(.cmh-copilot)');
  return JSON.stringify({
    cls: q('.conv-layout')?.className, sideD: side ? getComputedStyle(side).display : 'X',
    open: side?.classList.contains('open'), scrim: !!q('.conv-side-scrim'),
    info: info ? getComputedStyle(info).display : 'X',
  });
}));
// video sequence: wide → narrow → open drawer → wide → narrow → click ⓘ
await page.setViewportSize({ width: 780, height: 900 });
await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector('.cmh-info:not(.cmh-copilot)')?.click());
await page.waitForTimeout(400);
await st('drawer open:');
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForTimeout(500);
await st('widened:');
await page.setViewportSize({ width: 780, height: 900 });
await page.waitForTimeout(500);
await st('narrow again:');
await page.evaluate(() => document.querySelector('.conv-mobile-head .cmh-info:not(.cmh-copilot)')?.click());
await page.waitForTimeout(400);
await st('click ⓘ:');
await browser.close();
