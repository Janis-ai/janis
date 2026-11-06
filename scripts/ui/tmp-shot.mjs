import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(500);
await page.screenshot({ path: 'scripts/ui/out/head-docked.png', clip: { x: 0, y: 0, width: 1440, height: 110 } });
// scroll the sidebar to check pin behavior
await page.evaluate(() => { document.querySelector('.sidebar').scrollTop = 400; });
await page.waitForTimeout(200);
await page.screenshot({ path: 'scripts/ui/out/head-scrolled.png', clip: { x: 0, y: 0, width: 300, height: 200 } });
await browser.close();
