import { chromium } from 'playwright';
import fs from 'fs';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const r = await page.evaluate(() => {
  const fields = [...document.querySelectorAll('input[type="text"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], textarea')];
  return fields.map(i => {
    let card = i;
    for (let k = 0; k < 8 && card; k++) { card = card.parentElement; if (card?.innerText.match(/\d+\s*\/\s*\d+/)) break; }
    const counter = card?.innerText.match(/(\d+)\s*\/\s*(\d+)/);
    return {
      n: i.name || '(unnamed)', ph: i.placeholder?.slice(0, 40),
      len: i.value.length, max: i.maxLength > 0 && i.maxLength < 10000 ? i.maxLength : null,
      counter: counter ? `${counter[1]}/${counter[2]}` : null,
      tail: i.value.slice(-30),
    };
  }).filter(f => f.counter || f.max);
});
fs.writeFileSync('/tmp/partner/limits.json', JSON.stringify(r, null, 1));
for (const f of r) console.log(f.n, '| counter:', f.counter, '| len:', f.len, '| tail:', JSON.stringify(f.tail));
await ctx.close();
