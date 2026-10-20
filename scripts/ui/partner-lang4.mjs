import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
// inspect the languages UI region — what reveals the list?
const region = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find(x => x.textContent.trim() === 'Languages');
  let n = h; const texts = [];
  for (let i = 0; i < 8 && n; i++) { n = n.nextElementSibling ?? n.parentElement?.nextElementSibling; if (n) texts.push(n.textContent.trim().slice(0, 100)); }
  const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /language|english|choose|select|add/i.test(t));
  return { after: texts, langBtns: btns };
});
console.log(JSON.stringify(region, null, 1));
await ctx.close();
