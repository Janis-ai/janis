import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/pricing/bbc74ee5092894c6b45e93e24db1ede6', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
// get href of the first Add link (Public plans)
const links = await page.evaluate(() =>
  [...document.querySelectorAll('a, button')].filter(e => e.textContent.trim() === 'Add').map(e => ({ tag: e.tagName, href: e.href || '', dis: e.disabled, vis: e.offsetParent !== null })));
console.log('add links:', JSON.stringify(links));
const nav = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
await page.locator('a:has-text("Add"), button:has-text("Add")').first().click();
await nav;
await page.waitForTimeout(6000);
console.log('url:', page.url());
await page.screenshot({ path: `${OUT}/48-plan-form.png` });
const ctrls = await page.evaluate(() => [...document.querySelectorAll('input,textarea,button,select')].filter(c => c.offsetParent !== null).map(c => ({ t: c.tagName.toLowerCase(), ty: c.type || '', n: c.name || '', ph: c.placeholder || '', x: (c.textContent || '').trim().slice(0, 60) })));
console.log(JSON.stringify(ctrls.slice(0, 60)));
await ctx.close();
