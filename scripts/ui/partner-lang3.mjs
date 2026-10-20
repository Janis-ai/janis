import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator('label:has(input[id=":r11:"])').scrollIntoViewIfNeeded();
await page.locator('label:has(input[id=":r11:"])').click();
await page.waitForTimeout(1000);
const checked = await page.evaluate(() => document.querySelector('input[id=":r11:"]')?.checked);
console.log('english checked:', checked);
// save via top bar
await page.locator('header button:has-text("Save"), [class*="contextualSave"] button:has-text("Save")').first().click().catch(async () => {
  await page.locator('button:has-text("Save")').last().click();
});
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/20-lang-saved.png`, fullPage: false });
console.log('saved');
await ctx.close();
