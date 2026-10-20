import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
// replace file input #3 (4th slot)
await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Desktop screenshots');
  let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
  c.querySelectorAll('input[type="file"]')[3].setAttribute('data-swap', '1');
});
await page.locator('input[data-swap="1"]').setInputFiles('/Users/mnatha/Documents/shopify-listing/07-storefront.png');
await page.waitForTimeout(8000);
await page.locator('input[name="desktopScreenshots.3.imageAltText"]').fill('Shoppers get product picks with add-to-cart right in chat');
await page.screenshot({ path: `${OUT}/85-swapped.png` });
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
await page.waitForTimeout(7000);
console.log('saved:', await page.evaluate(() => (document.body.innerText.match(/(\d+) issues?/) || [])[0] ?? 'no issues'));
await ctx.close();
