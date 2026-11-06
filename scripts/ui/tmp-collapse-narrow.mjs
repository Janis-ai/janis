import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.setViewportSize({ width: 1400, height: 900 });
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.waitForTimeout(500);
const st = (t) => page.evaluate((t) => {
  const q = (s) => document.querySelector(s);
  const S = q('.conv-side');
  return t + ' ' + JSON.stringify({ cls: q('.conv-layout').className, sd: getComputedStyle(S).display, open: S.classList.contains('open'), scrim: !!q('.conv-side-scrim') });
}, t);
const clickVis = async (sel) => {
  const c = await page.evaluate((s) => {
    const el = [...document.querySelectorAll(s)].find((e) => getComputedStyle(e).display !== 'none');
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  if (!c) return false; await page.mouse.click(c.x, c.y); return true;
};
console.log('collapse clicked:', await clickVis('.cmh-collapse'));
await page.waitForTimeout(300); console.log(await st('after collapse'));
await page.setViewportSize({ width: 800, height: 900 });
await page.waitForTimeout(600); console.log(await st('narrow'));
console.log('ⓘ1 clicked:', await clickVis('.cmh-info:not(.cmh-copilot)'));
await page.waitForTimeout(400); console.log(await st('after ⓘ1'));
console.log('ⓘ2 clicked:', await clickVis('.cmh-info:not(.cmh-copilot)'));
await page.waitForTimeout(400); console.log(await st('after ⓘ2'));
await browser.close();
