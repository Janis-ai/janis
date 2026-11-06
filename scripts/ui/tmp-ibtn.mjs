import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
// narrow to drawer mode first, open it, then wide+narrow (the stale path)
await page.setViewportSize({ width: 780, height: 900 });
await page.waitForTimeout(400);
const st = async (t) => console.log(t, await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const side = q('.conv-side');
  return JSON.stringify({
    cls: q('.conv-layout')?.className, sideD: side ? getComputedStyle(side).display : 'X',
    open: side?.classList.contains('open'), scrim: !!q('.conv-side-scrim'),
    info: q('.cmh-info:not(.cmh-copilot)') ? getComputedStyle(q('.cmh-info:not(.cmh-copilot)')).display : 'X',
  });
}));
await st('narrow:');
// click the real ⓘ element
await page.evaluate(() => document.querySelector('.cmh-info:not(.cmh-copilot)')?.click());
await page.waitForTimeout(400);
await st('click1:');
await page.evaluate(() => document.querySelector('.cmh-info:not(.cmh-copilot)')?.click());
await page.waitForTimeout(400);
await st('click2:');
await browser.close();
