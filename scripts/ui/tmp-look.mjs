import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
for (const w of [900, 500]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `scripts/ui/out/look-${w}.png`, clip: { x: 0, y: 0, width: w, height: 120 } });
  console.log(w, await page.evaluate(() => {
    const els = [...document.querySelectorAll('.cmh-info, .cmh-collapse')].map((e) => {
      const r = e.getBoundingClientRect();
      return `${e.className.split(' ').filter(Boolean).join('.')}@${Math.round(r.left)},${Math.round(r.top)} ${getComputedStyle(e).display} parent:${e.parentElement.className.split(' ')[0]}`;
    });
    return els.join(' | ');
  }));
}
await browser.close();
