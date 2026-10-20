import { chromium } from 'playwright';
import fs from 'fs';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const out = await page.evaluate(() => {
  const res = {};
  // assetTypeSelection radio labels
  res.assetRadios = [...document.querySelectorAll('input[name="assetTypeSelection"]')].map(r => ({
    chk: r.checked, label: r.closest('label')?.textContent.trim() ?? r.parentElement?.textContent.trim().slice(0, 80),
  }));
  // category detail inputs — find smallest wrapper with heading
  const detInputs = [...document.querySelectorAll('input')].filter(i => i.placeholder.startsWith('Example:'));
  res.catDetail = detInputs.map(i => {
    let wrap = i; for (let k = 0; k < 6 && wrap; k++) { wrap = wrap.parentElement; if (wrap?.querySelector('h3, legend, label')) break; }
    return { ph: i.placeholder, wrapText: wrap?.innerText.slice(0, 200), tagCount: wrap?.parentElement?.querySelectorAll('[class*="Tag"], [class*="Selected"]').length };
  });
  // sales channel radios
  res.sales = ['salesChannelRequiredSelection', 'noSalesChannelRequiredSelection'].map(n =>
    [...document.querySelectorAll(`input[name="${n}"]`)].map(r => ({
      name: n, chk: r.checked, val: r.value, label: r.closest('label')?.textContent.trim().slice(0, 160),
    }))).flat();
  // subtitle current value
  res.subtitle = document.querySelector('input[name="subtitle"]')?.value;
  // pricing — find heading then its card
  const ph = [...document.querySelectorAll('h2,h3')].find(x => x.textContent.trim() === 'Pricing details');
  let pc = ph; for (let i = 0; i < 8 && pc; i++) { pc = pc.parentElement; if (pc?.querySelector('input,button')) break; }
  // find tighter: next sibling section containing plan controls
  res.pricing = null;
  if (ph) {
    // search forward from heading for plan-related controls
    let node = ph;
    for (let i = 0; i < 5 && node; i++) node = node.parentElement;
    const scope = node;
    const ctrl = [...scope.querySelectorAll('input,textarea,button')].map(c => ({
      t: c.tagName.toLowerCase(), ty: c.type || '', n: c.name || '', ph: c.placeholder || '', x: (c.textContent || '').trim().slice(0, 60), v: c.offsetParent !== null,
    }));
    res.pricing = { text: scope.innerText.slice(0, 1500), ctrl: ctrl.filter(c => c.v) };
  }
  // feature media file inputs count + screenshot inputs
  res.fileInputs = [...document.querySelectorAll('input[type="file"]')].map(f => ({ n: f.name, accept: f.accept, multi: f.multiple }));
  return res;
});
fs.writeFileSync('/tmp/partner/inspect3.json', JSON.stringify(out, null, 1));
console.log('done');
await ctx.close();
