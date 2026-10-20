import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/storefront-profile', { headless: true, viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://snowboardsareus.myshopify.com', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(4000);
console.log('url:', page.url());
const hasPw = await page.locator('input[type="password"], input[name="password"]').count();
console.log('password form:', hasPw);
if (hasPw) {
  await page.locator('input[type="password"], input[name="password"]').first().fill('newtsu');
  await page.locator('button[type="submit"], input[type="submit"], button:has-text("Enter")').first().click();
  await page.waitForTimeout(6000);
  console.log('after pw:', page.url());
}
await page.screenshot({ path: `${OUT}/70-storefront.png` });
// is the Janis bubble present?
const bubble = await page.evaluate(() => {
  const els = [...document.querySelectorAll('[class*="janis"], [id*="janis"], iframe[src*="janis"], script[src*="janis"]')];
  return els.map(e => e.tagName + '.' + (e.className || e.id || '').toString().slice(0, 40)).slice(0, 10);
});
console.log('janis els:', JSON.stringify(bubble));
await ctx.close();
