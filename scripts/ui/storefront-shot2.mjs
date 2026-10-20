import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/storefront-profile', { headless: true, viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://snowboardsareus.myshopify.com', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(4000);
const hasPw = await page.locator('input[type="password"]').count();
if (hasPw) {
  await page.locator('input[type="password"]').first().fill('newtsu');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(6000);
}
// open the bubble
await page.locator('.janis-bubble, button.janis-bubble').first().click();
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/71-storefront-open.png` });
// type a shopper question to make it lively? keep greeting state for the shot — check what's inside
const panel = await page.evaluate(() => document.querySelector('.janis-panel')?.innerText.slice(0, 500));
console.log(panel);
await ctx.close();
