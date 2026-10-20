import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const dsFiles = () => page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Desktop screenshots');
  let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
  return c.querySelectorAll('input[type="file"]').length;
});
let n = await dsFiles();
console.log('current slots:', n);
// try to add a 7th
await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Desktop screenshots');
  let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
  [...c.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add')?.click();
});
await page.waitForTimeout(1500);
n = await dsFiles();
console.log('after add:', n);
if (n >= 7) {
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Desktop screenshots');
    let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
    c.querySelectorAll('input[type="file"]')[6].setAttribute('data-ds7', '1');
  });
  await page.locator('input[data-ds7="1"]').setInputFiles('/Users/mnatha/Documents/shopify-listing/07-storefront.png');
  await page.waitForTimeout(6000);
  await page.locator('input[name="desktopScreenshots.6.imageAltText"]').fill('Shoppers get product picks with add-to-cart right in chat');
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
  await page.waitForTimeout(7000);
  console.log('saved:', await page.evaluate(() => (document.body.innerText.match(/(\d+) issues?/) || [])[0] ?? 'no issues'));
}
await page.screenshot({ path: `${OUT}/84-shot7.png` });
await ctx.close();
