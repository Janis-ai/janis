import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/distribution/app-store', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
console.log('dist url:', page.url());
const ok = await page.evaluate(() => document.body.innerText.includes('App Store review'));
console.log('dist ok:', ok);
// try the app overview → find configuration link
await page.goto('https://partners.shopify.com/5256121/apps/435599310849/overview', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
console.log('overview url:', page.url());
await page.screenshot({ path: `${OUT}/62-overview.png` });
const links = await page.evaluate(() => [...document.querySelectorAll('a')].map(a => ({ t: a.textContent.trim().slice(0, 40), h: a.href })).filter(x => /config|setup|edit|setting/i.test(x.t + x.h)).slice(0, 20));
console.log(JSON.stringify(links, null, 1));
await ctx.close();
