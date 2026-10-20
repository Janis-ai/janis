import { chromium } from 'playwright';
import { cookies } from './partner-cookies.mjs';
import fs from 'fs';

const OUT = '/tmp/partner';
fs.mkdirSync(OUT, { recursive: true });
const url = process.argv[2] ?? 'https://dev.shopify.com/dashboard/5256121/apps';
const shot = process.argv[3] ?? '02-devdash';

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/${shot}.png` });
console.log('url:', page.url());
console.log('title:', await page.title());
await browser.close();
