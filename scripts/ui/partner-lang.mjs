import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
// Languages section — inspect
const langs = await page.evaluate(() => {
  const sec = [...document.querySelectorAll('h2,h3')].find(h => h.textContent.trim() === 'Languages');
  const scope = sec?.parentElement?.parentElement ?? document;
  return {
    html: scope?.innerHTML?.slice(0, 400),
    labels: [...scope.querySelectorAll('label')].map(l => l.textContent.trim()).slice(0, 12),
    inputs: [...scope.querySelectorAll('input')].map(i => ({ t: i.type, ph: i.placeholder })).slice(0, 6),
    buttons: [...scope.querySelectorAll('button')].map(b => b.textContent.trim()).slice(0, 8),
  };
});
console.log(JSON.stringify(langs, null, 1).slice(0, 3000));
await ctx.close();
