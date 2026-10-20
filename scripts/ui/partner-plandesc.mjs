import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/pricing/bbc74ee5092894c6b45e93e24db1ede6/scale?billingSystem=manual', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(6000);
const nav = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
await page.locator('a:has-text("Add a plan description for English")').first().click().catch(async () => {
  await page.evaluate(() => [...document.querySelectorAll('a,button,span')].find(e => e.textContent.includes('Add a plan description'))?.click());
});
await nav;
await page.waitForTimeout(6000);
console.log('url:', page.url());
await page.screenshot({ path: `${OUT}/50-plandesc.png` });
const ctrls = await page.evaluate(() => [...document.querySelectorAll('input,textarea,button,select')].filter(c => c.offsetParent !== null).map(c => ({ t: c.tagName.toLowerCase(), ty: c.type || '', n: c.name || '', ph: c.placeholder || '', x: (c.textContent || '').trim().slice(0, 70) })));
console.log(JSON.stringify(ctrls.slice(0, 60)));
await ctx.close();
