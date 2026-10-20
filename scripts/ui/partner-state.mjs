import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator('.param-multi-select-languages').scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
const r = await page.evaluate(() => {
  const ms = document.querySelector('.param-multi-select-languages');
  const sel = [...ms.querySelectorAll('[class*="Selected"]')].map(d => d.textContent.trim()).filter(Boolean);
  const issues = document.querySelector('[class*="issues"], [class*="Issue"]');
  const issueCount = (document.body.innerText.match(/(\d+) issues?/) || [])[0];
  return { sel, issueCount };
});
console.log(JSON.stringify(r));
await page.screenshot({ path: `${OUT}/27-state.png` });
await ctx.close();
