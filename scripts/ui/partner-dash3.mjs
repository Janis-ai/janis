import { chromium } from 'playwright';
import { cookies } from './partner-cookies.mjs';
import fs from 'fs';

const OUT = '/tmp/partner';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
await page.goto('https://partners.shopify.com/5256121/apps', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4000);
await page.locator('a:has-text("Janis")').first().click();
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/04-app.png` });
console.log('url:', page.url());
await browser.close();
