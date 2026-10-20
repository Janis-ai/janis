import { chromium } from 'playwright';
import { cookies } from './partner-cookies.mjs';
import fs from 'fs';

const OUT = '/tmp/partner';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();

// land on the org dashboard
await page.goto('https://partners.shopify.com/5256121', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/01-dash.png` });
console.log('url:', page.url());
console.log('title:', await page.title());

await browser.close();
