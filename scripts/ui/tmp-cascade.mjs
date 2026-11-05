import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
// land on a conversation
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.waitForTimeout(400);
const probe = async (w) => {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(350);
  return await page.evaluate(() => {
    const sb = document.querySelector('.sidebar');
    const inbox = document.querySelector('.conv-inbox');
    const rail = document.querySelector('.conv-side');
    const main = document.querySelector('.conv-main');
    const vis = (el) => el ? getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0 : null;
    const info = (el) => el ? Math.round(el.getBoundingClientRect().width) : null;
    const layout = document.querySelector('.conv-layout');
    return {
      nav: vis(sb) ? info(sb) : 'hidden',
      mini: sb?.classList.contains('mini') ?? null,
      inbox: vis(inbox) ? info(inbox) : 'hidden',
      main: info(main),
      rail: vis(rail) ? info(rail) : 'hidden',
      railTight: layout?.classList.contains('rail-tight'),
      listTight: layout?.classList.contains('list-tight'),
    };
  });
};
for (const w of [1440, 1180, 1000, 850, 700]) {
  console.log(w + 'px:', JSON.stringify(await probe(w)));
}
// resize-reset: drag the col grip wider at 1440, then shrink → back to 290
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(350);
const grip = await page.locator('.conv-col-grip').boundingBox();
if (grip) {
  await page.mouse.move(grip.x + 4, grip.y + 200);
  await page.mouse.down();
  await page.mouse.move(grip.x + 100, grip.y + 200, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const w1 = await page.evaluate(() => Math.round(document.querySelector('.conv-inbox').getBoundingClientRect().width));
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.waitForTimeout(350);
  const r = await page.evaluate(() => {
    const el = document.querySelector('.conv-inbox');
    return el && getComputedStyle(el).display !== 'none' ? Math.round(el.getBoundingClientRect().width) : 'hidden';
  });
  console.log('drag-then-resize: colAfterDrag=' + w1 + ' colAfterResize=' + r);
}
await browser.close();
