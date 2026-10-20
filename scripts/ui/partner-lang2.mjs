import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const info = await page.evaluate(() => {
  const cbs = [...document.querySelectorAll('input[type="checkbox"]')];
  const en = cbs.find(c => {
    const lab = c.closest('label') ?? c.parentElement?.querySelector('label');
    return lab?.textContent.trim() === 'English';
  });
  const lab = en?.closest('label') ?? en?.parentElement?.querySelector('label');
  return { total: cbs.length, found: !!en, labelText: lab?.textContent?.trim().slice(0, 30), id: en?.id, name: en?.name, checked: en?.checked };
});
console.log(JSON.stringify(info));
await ctx.close();
