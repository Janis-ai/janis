import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/pricing/bbc74ee5092894c6b45e93e24db1ede6', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(6000);
const nav = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
await page.locator('section:has-text("Public plans") button:has-text("Add"), div:has-text("All merchants can view") button:has-text("Add")').first().click().catch(async () => {
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.includes('All merchants can view'));
    let c = el; for (let i = 0; i < 8 && c; i++) c = c.parentElement;
    [...c.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add')?.click();
  });
});
await nav;
await page.waitForTimeout(6000);
console.log('url:', page.url());
await page.screenshot({ path: `${OUT}/46-plan-form.png` });
const ctrls = await page.evaluate(() => [...document.querySelectorAll('input,textarea,button,select')].filter(c => c.offsetParent !== null).map(c => ({ t: c.tagName.toLowerCase(), ty: c.type || '', n: c.name || '', ph: c.placeholder || '', x: (c.textContent || '').trim().slice(0, 60), v: c.value?.slice(0, 40) })));
console.log(JSON.stringify(ctrls.slice(0, 60), null, 1));
await ctx.close();
