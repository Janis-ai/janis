import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/storefront-profile', { headless: true, viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://snowboardsareus.myshopify.com', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(5000);
console.log('url:', page.url());
if (page.url().includes('/password')) {
  await page.locator('input[name="password"], input[type="password"]').first().fill('newtsu');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);
  console.log('after pw:', page.url());
}
// wait for widget to paint
await page.waitForSelector('.janis-bubble', { timeout: 30000 }).catch(() => console.log('no bubble'));
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/71a-closed.png` });
await page.locator('.janis-bubble').click().catch(e => console.log('click fail'));
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/71b-open.png` });
const panel = await page.evaluate(() => document.querySelector('.janis-panel')?.innerText.slice(0, 500) ?? 'no panel');
console.log(panel);
await ctx.close();
