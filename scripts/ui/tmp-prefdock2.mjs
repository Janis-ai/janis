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
const w = () => page.evaluate(() => ({
  nav: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
  btn: (() => { const b = document.querySelector('.nav-collapse'); return b ? getComputedStyle(b).display : 'none'; })(),
  pref: localStorage.getItem('nav.collapse'),
}));
console.log('after-dock:', JSON.stringify(await w()));
await page.evaluate(() => document.querySelector('.nav-collapse').click());
await page.waitForTimeout(400);
console.log('after-click:', JSON.stringify(await w()));
await browser.close();
