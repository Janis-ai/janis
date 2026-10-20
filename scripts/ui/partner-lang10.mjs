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
await page.locator('input[placeholder="search"]').fill('English');
await page.waitForTimeout(1500);
await page.locator('.param-multi-select-languages label:has-text("English")').first().click();
await page.waitForTimeout(1200);
// close dropdown
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
const st = await page.evaluate(() => {
  const cbs = [...document.querySelectorAll('input[type="checkbox"]')];
  const en = cbs.find(c => (c.closest('label') ?? c.parentElement?.querySelector('label'))?.textContent.trim() === 'English');
  return en?.checked;
});
console.log('english checked:', st);
// save top-level
await page.locator('button:has-text("Save")').first().click().catch(() => {});
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/24-saved2.png` });
console.log('saved');
await ctx.close();
