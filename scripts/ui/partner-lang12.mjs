import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator('.param-multi-select-languages > button').scrollIntoViewIfNeeded();
await page.locator('.param-multi-select-languages > button').click();
await page.waitForTimeout(1500);
await page.locator('.param-multi-select-languages input[type="search"], .param-multi-select-languages input[placeholder*="earch"]').fill('English');
await page.waitForTimeout(1500);
await page.locator('.param-multi-select-languages label:has-text("English")').first().click();
await page.waitForTimeout(1200);
const st = await page.evaluate(() => [...document.querySelectorAll('.param-multi-select-languages input[type="checkbox"]')].find(c => c.checked)?.closest('label')?.textContent.trim() ?? 'none-checked');
console.log('checked language:', st);
await page.screenshot({ path: `${OUT}/25-lang-picked.png` });
// save via top bar
await page.locator('header button:has-text("Save"), [class*="Save"] button:has-text("Save")').first().click().catch(async () => {
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save')?.click());
});
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/26-saved.png` });
console.log('saved — url:', page.url());
await ctx.close();
