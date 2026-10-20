import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
// click the Select button inside the Languages section
await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find(x => x.textContent.trim() === 'Languages');
  const sec = h.closest('section, [class*="section"], div[class*="Polaris-Box"]') ?? h.parentElement.parentElement.parentElement;
  const btn = [...sec.querySelectorAll('button')].find(b => b.textContent.trim() === 'Select');
  btn?.click();
});
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/21-lang-modal.png` });
const dlg = await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  return d ? { open: true, search: !!d.querySelector('input[type="search"], input[placeholder*="earch"]'), title: d.querySelector('h2,h3')?.textContent } : { open: false };
});
console.log(JSON.stringify(dlg));
await ctx.close();
