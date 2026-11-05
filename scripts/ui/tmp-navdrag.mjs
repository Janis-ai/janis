import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
const state = async (tag) => console.log(tag, await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const vis = (el) => el && getComputedStyle(el).display !== 'none';
  const layout = q('.conv-layout');
  return JSON.stringify({
    nav: Math.round(q('.sidebar').getBoundingClientRect().width),
    inbox: vis(q('.conv-inbox')) ? Math.round(q('.conv-inbox').getBoundingClientRect().width) : 'X',
    railTight: layout.classList.contains('rail-tight'),
    listTight: layout.classList.contains('list-tight'),
  });
}));
await page.setViewportSize({ width: 1240, height: 900 });
await page.waitForTimeout(400);
await state('start-1240:');
// DRAG the nav edge wider — rail should yield to the drawer mid-drag
const grip = await page.locator('.nav-grip').boundingBox();
await page.mouse.move(grip.x + 4, grip.y + 300);
await page.mouse.down();
await page.mouse.move(grip.x + 120, grip.y + 300, { steps: 8 });
await state('mid-drag:');
await page.mouse.up();
await page.waitForTimeout(500);
await state('post-drag:');
// now drag it back down under the collapse threshold — everything returns
await page.mouse.move(grip.x + 120 + 4, grip.y + 300);
await page.mouse.down();
await page.mouse.move(30, grip.y + 300, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(500);
await state('post-collapse-drag:');
await browser.close();
