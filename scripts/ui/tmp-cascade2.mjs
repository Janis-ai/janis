import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
// simulate the user's pinned expand pref at a wide size, then shrink
await page.evaluate(() => localStorage.setItem('nav.collapse', JSON.stringify({ v: 'expanded', vw: 1440 })));
await page.setViewportSize({ width: 1180, height: 900 });
await page.waitForTimeout(400);
const probe = async () => await page.evaluate(() => {
  const sb = document.querySelector('.sidebar');
  const inbox = document.querySelector('.conv-inbox');
  const layout = document.querySelector('.conv-layout');
  const vis = (el) => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
  return {
    nav: vis(sb) ? Math.round(sb.getBoundingClientRect().width) : 'hidden',
    inbox: vis(inbox) ? Math.round(inbox.getBoundingClientRect().width) : 'hidden',
    railTight: layout?.classList.contains('rail-tight'),
    listTight: layout?.classList.contains('list-tight'),
  };
});
console.log('stale-expand @1180:', JSON.stringify(await probe()));
// now with a CURRENT-size expand pref — explicit expand should win
await page.evaluate(() => localStorage.setItem('nav.collapse', JSON.stringify({ v: 'expanded', vw: 1180 })));
await page.setViewportSize({ width: 1179, height: 900 });
await page.setViewportSize({ width: 1180, height: 900 });
await page.waitForTimeout(400);
console.log('fresh-expand @1180:', JSON.stringify(await probe()));
await browser.close();
