import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);
const state = async (tag) => console.log(tag, await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const vis = (el) => el && getComputedStyle(el).display !== 'none';
  const r = (el) => Math.round(el.getBoundingClientRect().width);
  return JSON.stringify({
    inbox: r(q('.conv-inbox')), main: r(q('.conv-main')),
    rail: vis(q('.conv-side')) ? r(q('.conv-side')) : 'X',
    hideBtn: vis(q('.rail-hide')), xBtn: vis(q('.rail-x')),
    infoTop: vis(q('.conv-mobile-head .cmh-info:not(.cmh-copilot)')),
    infoBoxed: !!q('.info-btn'),
    railClosed: q('.conv-layout').classList.contains('rail-closed'),
  });
}));
await state('docked:');
await page.locator('.rail-hide').click();
await page.waitForTimeout(400);
await state('closed:');
await page.locator('.conv-mobile-head .cmh-info:not(.cmh-copilot)').click();
await page.waitForTimeout(400);
await state('reopened:');
await browser.close();
