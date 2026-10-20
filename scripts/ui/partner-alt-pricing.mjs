import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
// fill feature image alt text
await page.locator('input[name="promotionalImageAltText"]').fill('Unified inbox: web chat, Messenger, Instagram, WhatsApp');
await page.waitForTimeout(600);
// save
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
await page.waitForTimeout(6000);
console.log('after alt save:', await page.evaluate(() => (document.body.innerText.match(/(\d+) issues?/) || [])[0] ?? 'no-issue-label'));
// now open the Manage pricing button
await page.locator('button:has-text("Manage")').scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
const nav = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
await page.locator('button:has-text("Manage")').click();
await nav;
await page.waitForTimeout(6000);
console.log('landed:', page.url());
await page.screenshot({ path: `${OUT}/45-pricing.png` });
// dump controls on the pricing page
const ctrls = await page.evaluate(() => [...document.querySelectorAll('input,textarea,button,select')].filter(c => c.offsetParent !== null).map(c => ({ t: c.tagName.toLowerCase(), ty: c.type || '', n: c.name || '', ph: c.placeholder || '', x: (c.textContent || '').trim().slice(0, 60) })));
console.log(JSON.stringify(ctrls.slice(0, 50), null, 1));
await ctx.close();
