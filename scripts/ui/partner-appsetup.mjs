import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
// app setup / configuration page
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/edit', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
console.log('url:', page.url());
await page.screenshot({ path: `${OUT}/61-appsetup.png` });
const txt = await page.evaluate(() => document.body.innerText.slice(0, 3000));
console.log(txt);
await ctx.close();
