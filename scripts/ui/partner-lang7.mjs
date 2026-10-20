import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
// the multi-select trigger: the search input inside ParamMultiSelect
await page.locator('[class*="ParamMultiSelect"] input, input[type="search"]').first().scrollIntoViewIfNeeded();
await page.locator('[class*="ParamMultiSelect"] input, input[type="search"]').first().click();
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/22-lang-open.png` });
// click English option
const clicked = await page.evaluate(() => {
  const opts = [...document.querySelectorAll('[class*="ParamMultiSelect"] [role="option"], [class*="ParamMultiSelect"] label')];
  const en = opts.find(o => o.textContent.trim() === 'English');
  en?.click();
  return en?.textContent.trim() ?? 'not found';
});
console.log('clicked:', clicked);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/23-lang-picked.png` });
await ctx.close();
