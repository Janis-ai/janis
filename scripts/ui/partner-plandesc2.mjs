import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const r = await page.evaluate(() => {
  const hs = [...document.querySelectorAll('h2,h3')];
  const start = hs.find(x => x.textContent.trim() === 'Pricing details');
  const end = hs.find(x => x.textContent.trim() === 'App discovery content');
  if (!start || !end) return 'missing';
  const range = document.createRange();
  range.setStartAfter(start);
  range.setEndBefore(end);
  const frag = range.cloneContents();
  const div = document.createElement('div');
  div.appendChild(frag);
  // fields named like plans.X.*
  const named = [...document.querySelectorAll('input,textarea')].filter(i => /plan/i.test(i.name)).map(i => ({ n: i.name, v: i.value.slice(0, 60), ph: i.placeholder }));
  // scrollable DOM: find elements between the two headings
  const midInputs = [];
  let node = start.parentElement;
  while (node) {
    if (node.contains(end)) break;
    for (const el of node.querySelectorAll?.('input,textarea,button') ?? []) {
      midInputs.push({ t: el.tagName.toLowerCase(), ty: el.type, n: el.name, ph: el.placeholder, x: el.textContent?.trim().slice(0, 40) });
    }
    node = node.nextElementSibling;
  }
  return { text: div.innerText.slice(0, 2500), named, midInputs: midInputs.slice(0, 40) };
});
console.log(JSON.stringify(r, null, 1));
await ctx.close();
