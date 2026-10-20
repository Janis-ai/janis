import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/storefront-profile', { headless: true, viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const fails = [];
page.on('response', r => { if (r.url().includes('janis')) fails.push(r.status() + ' ' + r.url().slice(0, 110)); });
page.on('console', m => { if (m.type() === 'error') fails.push('CONSOLE: ' + m.text().slice(0, 120)); });
await page.goto('https://snowboardsareus.myshopify.com', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
if (page.url().includes('/password')) {
  await page.locator('input[type="password"]').first().fill('newtsu');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);
}
await page.waitForTimeout(30000);
const r = await page.evaluate(() => ({
  janisScripts: [...document.querySelectorAll('script[src*="janis"]')].map(s => s.src.slice(0, 120)),
  inHtml: document.documentElement.innerHTML.includes('storefront.js'),
}));
console.log(JSON.stringify(r, null, 1));
console.log('network:', JSON.stringify(fails, null, 1));
await ctx.close();
