import { chromium } from 'playwright';
import fs from 'fs';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const out = await page.evaluate(() => {
  const hs = [...document.querySelectorAll('h2,h3')];
  const start = hs.find(x => x.textContent.trim() === 'Pricing details');
  const end = hs.find(x => x.textContent.trim() === 'App discovery content');
  if (!start || !end) return 'missing ' + !start + ' ' + !end;
  const range = document.createRange();
  range.setStartAfter(start);
  range.setEndBefore(end);
  const frag = range.cloneContents();
  const div = document.createElement('div');
  div.appendChild(frag);
  // also live DOM between them for controls
  const controls = [];
  let node = start;
  while (node && node !== end) {
    if (node.querySelectorAll) {
      for (const el of node.querySelectorAll('input,textarea,button,select,a')) {
        if (!controls.find(c => c.el === el)) {
          controls.push({ t: el.tagName.toLowerCase(), ty: el.type || '', n: el.name || '', ph: el.placeholder || '', x: (el.textContent || '').trim().slice(0, 60), href: el.href || '', v: el.offsetParent !== null });
        }
      }
    }
    node = node.nextElementSibling;
  }
  return { text: div.innerText.slice(0, 2500), controls: controls.filter(c => c.v) };
});
fs.writeFileSync('/tmp/partner/pricing.json', JSON.stringify(out, null, 1));
console.log('done');
await ctx.close();
