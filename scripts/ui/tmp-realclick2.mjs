import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);
const click = async (sel) => {
  const c = await page.evaluate((s) => {
    const els = [...document.querySelectorAll(s)].filter((e) => getComputedStyle(e).display !== 'none');
    const el = els[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: hit ? (hit.closest('button')?.className || hit.tagName) : 'none', n: els.length };
  }, sel);
  if (!c) return 'no-el';
  await page.mouse.click(c.x, c.y);
  return `hit=${c.hit} n=${c.n}`;
};
console.log('collapse:', await click('.conv-mobile-head .cmh-collapse'));
await page.waitForTimeout(400);
console.log('reopen:', await click('.conv-mobile-head .cmh-info:not(.cmh-copilot)'));
await page.waitForTimeout(400);
console.log('side:', await page.evaluate(() => getComputedStyle(document.querySelector('.conv-side')).display));
await browser.close();
