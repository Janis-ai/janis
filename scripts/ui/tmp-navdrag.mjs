import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.setViewportSize({ width: 1140, height: 900 });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.evaluate(() => window.dispatchEvent(new CustomEvent('janis:open-copilot')));
await page.waitForTimeout(700);
const nav = () => page.evaluate(() => Math.round(document.querySelector('.sidebar').getBoundingClientRect().width));
console.log('start:', await nav());
const g = await page.evaluate(() => { const r = document.querySelector('.nav-grip').getBoundingClientRect(); return { x: r.left + 4, y: r.top + 200 }; });
// drag the mini rail's grip outward in steps
await page.mouse.move(g.x, g.y);
await page.mouse.down();
const widths = [];
for (let x = g.x; x <= g.x + 160; x += 40) { await page.mouse.move(x, g.y); widths.push(await nav()); }
console.log('mid:', JSON.stringify(widths));
await page.mouse.up();
await page.waitForTimeout(500);
console.log('end:', await nav(), 'mr:', await page.evaluate(() => getComputedStyle(document.querySelector('.main')).marginRight));
await browser.close();
