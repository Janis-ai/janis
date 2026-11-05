import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
const probe = async (w) => {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(350);
  return await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const vis = (el) => el && getComputedStyle(el).display !== 'none';
    const w2 = (el) => el ? Math.round(el.getBoundingClientRect().width) : null;
    return `nav=${w2(q('.sidebar'))} inbox=${vis(q('.conv-inbox')) ? w2(q('.conv-inbox')) : 'X'} main=${w2(q('.conv-main'))} rail=${w2(q('.conv-side'))}`;
  });
};
for (const w of [1150, 1100, 1060, 1020, 980, 940, 900]) console.log(w + ': ' + await probe(w));
await browser.close();
