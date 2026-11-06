import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);
console.log(await page.evaluate(() => {
  const r = (s) => document.querySelector(s)?.getBoundingClientRect();
  const inbox = r('.conv-inbox-head .search-box');
  const conv = r('.conv-mobile-head .conv-search, .conv-mobile-head input, .conv-mobile-head .search-wrap');
  const nav = r('.nav-collapse');
  const f = (x) => x ? `${Math.round(x.top)}-${Math.round(x.bottom)} (h${Math.round(x.height)})` : 'X';
  return `inbox=${f(inbox)} conv=${f(conv)} navBtn=${f(nav)}`;
}));
await page.screenshot({ path: 'scripts/ui/out/align.png', clip: { x: 0, y: 0, width: 1440, height: 90 } });
await browser.close();
