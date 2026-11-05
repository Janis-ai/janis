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
    const r = (el) => Math.round(el.getBoundingClientRect().width);
    const layout = q('.conv-layout');
    const main = q('.main');
    const cm = q('.conv-main');
    const cs = q('.conv-side');
    // gap = rail's left edge minus conv-main's right edge
    const gap = vis(cs) ? Math.round(cs.getBoundingClientRect().left - cm.getBoundingClientRect().right) : null;
    // left gap = conv-main left minus sidebar right
    const sb = q('.sidebar');
    const lgap = sb && vis(sb) ? Math.round(cm.getBoundingClientRect().left - sb.getBoundingClientRect().right) : null;
    return `inbox=${vis(q('.conv-inbox')) ? r(q('.conv-inbox')) : 'X'} main=${r(cm)} rail=${vis(cs) && !layout.classList.contains('rail-tight') ? r(cs) : 'drawer'} mainPadL=${getComputedStyle(main).paddingLeft} gapR=${gap} gapL=${lgap}`;
  });
};
for (const w of [1020, 980, 860, 800]) console.log(w + ': ' + await probe(w));
await browser.close();
