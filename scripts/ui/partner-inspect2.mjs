import { chromium } from 'playwright';
import fs from 'fs';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const out = {};
out.headings = await page.evaluate(() => [...document.querySelectorAll('h1,h2,h3,legend')].map(h => h.textContent.trim()).filter(Boolean));
out.sections = await page.evaluate(() => {
  // locate major section cards by left-nav labels
  const navLabels = ['Basic app information','App store listing content','Pricing details','App discovery content','Install requirements','App testing information'];
  const res = {};
  for (const label of navLabels) {
    const h = [...document.querySelectorAll('h2,h3')].find(x => x.textContent.trim() === label);
    if (!h) { res[label] = null; continue; }
    let card = h;
    for (let i = 0; i < 8 && card; i++) { card = card.parentElement; if (card?.innerText.length > 400) break; }
    res[label] = {
      text: card?.innerText.slice(0, 1500),
      ctrls: card ? [...card.querySelectorAll('input,textarea,select,button')].map(i => ({
        t: i.tagName.toLowerCase(), ty: i.type || '', n: i.name || '', ph: i.placeholder || '',
        x: (i.textContent || '').trim().slice(0, 50), v: i.offsetParent !== null, chk: i.checked,
      })).filter(c => c.v || c.ty === 'file' || c.ty === 'hidden') : [],
    };
  }
  return res;
});
// language multi-select current chips
out.langChips = await page.evaluate(() => {
  const ms = document.querySelector('.param-multi-select-languages');
  return ms ? ms.innerText.slice(0, 300) : null;
});
// category section state
out.category = await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find(e => e.children.length < 6 && e.textContent.trim() === 'App category');
  let card = el; for (let i = 0; i < 8 && card; i++) { card = card.parentElement; if (card?.innerText.length > 200) break; }
  return card?.innerText.slice(0, 1200);
});
fs.writeFileSync('/tmp/partner/inspect.json', JSON.stringify(out, null, 1));
console.log('written');
await ctx.close();
