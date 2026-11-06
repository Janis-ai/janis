import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
for (const w of [1440, 1150]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(400);
  console.log(w, await page.evaluate(() => {
    const rect = (s) => document.querySelector(s)?.getBoundingClientRect();
    const head = rect('.conv-mobile-head');
    const rail = rect('.conv-side');
    const btn = rect('.cmh-collapse');
    const card = rect('.conv-side .card');
    return JSON.stringify({
      headRight: Math.round(head.right), railRight: Math.round(rail.right),
      btnRight: btn ? Math.round(btn.right) : null,
      headBottom: Math.round(head.bottom), cardTop: card ? Math.round(card.top) : null,
    });
  }));
  await page.screenshot({ path: `scripts/ui/out/span-${w}.png`, clip: { x: 0, y: 0, width: w, height: 140 } });
}
await browser.close();
