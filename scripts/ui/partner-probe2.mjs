import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const out = { fields: {} };

const visLabels = () => page.evaluate(() =>
  [...document.querySelectorAll('label')].filter(l => l.offsetParent !== null && l.querySelector('input[type="checkbox"]')).map(l => l.textContent.trim()).filter(t => t.length < 70));

for (const [key, ph] of [
  ['rt', 'Example: AI chatbots, Live chat, SMS'],
  ['auto', 'Example: Cart recovery, COD verification, Discounts'],
  ['cust', 'Example: Color and font, Emojis and stickers, Chat window'],
]) {
  const inp = page.locator(`input[placeholder="${ph}"]`);
  await inp.scrollIntoViewIfNeeded();
  const before = await visLabels();
  await inp.click();
  await inp.pressSequentially(' ', { delay: 30 });
  await page.waitForTimeout(1200);
  const mid = await visLabels();
  const afterClick = mid.filter(x => !before.includes(x));
  // if nothing, type 'a'
  let all = afterClick;
  if (!afterClick.length || afterClick.every(x => x === 'Not applicable for this app')) {
    await inp.pressSequentially('a', { delay: 30 });
    await page.waitForTimeout(1200);
    const after = await visLabels();
    all = after.filter(x => !before.includes(x));
  }
  out.fields[key] = all;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
}
// feature media card
out.fm = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3,p,span,strong')].find(x => x.textContent.trim() === 'Feature media');
  if (!h) return 'no-heading';
  let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c && c.querySelector('input[type="file"]')) break; }
  if (!c) return 'no-card';
  return { text: c.innerText.slice(0, 500), files: c.querySelectorAll('input[type="file"]').length };
});
// desktop screenshots card
out.ds = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3,p,span,strong')].find(x => x.textContent.trim() === 'Desktop screenshots');
  if (!h) return 'no-heading';
  let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c && c.querySelector('input[type="file"]')) break; }
  if (!c) return 'no-card';
  return { text: c.innerText.slice(0, 600), files: c.querySelectorAll('input[type="file"]').length,
    adds: [...c.querySelectorAll('button')].map(b => b.textContent.trim()) };
});
// pricing section: find heading then next sibling card
out.pricing = await page.evaluate(() => {
  const hs = [...document.querySelectorAll('h2,h3')];
  const h = hs.find(x => x.textContent.trim() === 'Pricing details');
  if (!h) return 'no-heading';
  // walk up until element whose nextElementSibling contains inputs
  let c = h;
  for (let i = 0; i < 12 && c; i++) {
    c = c.parentElement;
    if (!c) break;
    const cards = [...c.children].filter(ch => ch.querySelectorAll?.('input,button').length > 0);
    if (cards.length) {
      const cand = cards.find(ch => ch.innerText.length > 60 && ch !== h.closest('div'));
      if (cand) {
        return { text: cand.innerText.slice(0, 1500),
          ctrls: [...cand.querySelectorAll('input,textarea,select,button')].map(x => ({ t: x.tagName.toLowerCase(), ty: x.type, n: x.name, ph: x.placeholder, x: x.textContent.trim().slice(0, 50) })).filter(x => x.t !== 'button' || x.x) };
      }
    }
  }
  return 'no-card';
});
fs.writeFileSync('/tmp/partner/probe2.json', JSON.stringify(out, null, 1));
console.log('done');
await ctx.close();
