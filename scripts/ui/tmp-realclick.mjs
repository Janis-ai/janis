import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
for (const w of [900, 780, 500]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => {
    const el = document.querySelector('.conv-mobile-head .cmh-info:not(.cmh-copilot)') || document.querySelector('.cmh-info:not(.cmh-copilot)');
    if (!el || getComputedStyle(el).display === 'none') return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: hit ? (hit.closest('button')?.className || hit.tagName).slice(0, 60) : 'none' };
  });
  if (!info) { console.log(w, 'no ⓘ visible'); continue; }
  await page.mouse.click(info.x, info.y);
  await page.waitForTimeout(400);
  const side = await page.evaluate(() => { const s = document.querySelector('.conv-side'); return `${getComputedStyle(s).display} open=${s.classList.contains('open')}`; });
  console.log(w, `hit=${info.hit} → side=${side}`);
}
await browser.close();
