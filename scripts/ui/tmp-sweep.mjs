import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
const st = async (t) => console.log(t, await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const vis = (el) => el && getComputedStyle(el).display !== 'none';
  const L = q('.conv-layout'), S = q('.conv-side');
  const layR = getComputedStyle(L).getPropertyValue('--lay-r');
  return JSON.stringify({
    cls: L.className.replace('conv-layout','').trim() || '-',
    nav: Math.round(q('.sidebar').getBoundingClientRect().width),
    inbox: vis(q('.conv-inbox')) ? Math.round(q('.conv-inbox').getBoundingClientRect().width) : 0,
    conv: Math.round(q('.conv-main').getBoundingClientRect().width),
    side: vis(S) ? `${Math.round(S.getBoundingClientRect().width)}@${Math.round(S.getBoundingClientRect().right)}` : 0,
    layR, win: innerWidth,
  });
}));
for (const w of [1440, 1100, 900, 700, 620, 500]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(500);
  await st(`w=${w}:`);
}
await browser.close();
