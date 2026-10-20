import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
// scroll to App category and open the Select modal
await page.locator('text=App category').first().scrollIntoViewIfNeeded();
await page.locator('button:has-text("Select")').first().click();
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/16-cat-modal.png` });
// dump modal's selectable options
const opts = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] label, [role="dialog"] button, [role="dialog"] li')].map(e => e.textContent.trim().slice(0, 60)).filter(Boolean).slice(0, 60));
console.log(JSON.stringify(opts));
await ctx.close();
