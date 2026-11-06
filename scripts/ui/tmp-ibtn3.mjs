import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.setViewportSize({ width: 500, height: 900 });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-mobile-head', { timeout: 10000 });
await page.waitForTimeout(400);
const st = async (t) => console.log(t, await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const side = q('.conv-side');
  return JSON.stringify({ sideD: getComputedStyle(side).display, open: side.classList.contains('open'), scrim: !!q('.conv-side-scrim') });
}));
await st('phone:');
await page.evaluate(() => document.querySelector('.cmh-info:not(.cmh-copilot)')?.click());
await page.waitForTimeout(400);
await st('click1:');
await browser.close();
