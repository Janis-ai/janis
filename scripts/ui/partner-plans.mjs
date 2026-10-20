import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const BASE = 'https://apps.shopify.com/services/pricing/bbc74ee5092894c6b45e93e24db1ede6';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
const log = (...a) => console.log('[plans]', ...a);

const plans = [
  { handle: 'free',   type: 'Free',              price: null, overage: false, trial: null },
  { handle: 'starter', type: 'Monthly recurring', price: '29',  overage: true,  trial: '0' },
  { handle: 'pro',    type: 'Monthly recurring', price: '99',  overage: true,  trial: '0' },
  { handle: 'scale',  type: 'Monthly recurring', price: '299', overage: true,  trial: '0' },
];

for (const p of plans) {
  await page.goto(`${BASE}/new`, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(5000);
  // handle = first visible text input
  const inputs = page.locator('form input[type="text"], main input[type="text"]');
  await inputs.first().fill(p.handle);
  // additional charges checkbox
  if (p.overage) {
    await page.evaluate(() => {
      const l = [...document.querySelectorAll('label')].find(x => x.textContent.includes('additional charges'));
      const cb = l?.querySelector('input[type="checkbox"]');
      if (cb && !cb.checked) l.click();
    });
    await page.waitForTimeout(400);
  }
  // billing type select
  await page.locator('select').first().selectOption({ label: p.type }).catch(async () => {
    const opts = await page.evaluate(() => [...document.querySelector('select').options].map(o => o.text));
    log('select options:', JSON.stringify(opts));
  });
  await page.waitForTimeout(800);
  if (p.price) {
    // "Monthly charge" field — the input after the label
    await page.evaluate((price) => {
      const lab = [...document.querySelectorAll('label, p, span, div')].find(e => e.children.length === 0 && e.textContent.trim() === 'Monthly charge');
      let wrap = lab; for (let i = 0; i < 6 && wrap; i++) { wrap = wrap.parentElement; if (wrap.querySelector('input')) break; }
      const inp = wrap.querySelector('input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, price);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, p.price);
    await page.waitForTimeout(500);
  }
  if (p.trial) {
    await page.evaluate((t) => {
      const lab = [...document.querySelectorAll('label, p, span, div')].find(e => e.children.length === 0 && e.textContent.trim() === 'Free trial duration');
      let wrap = lab; for (let i = 0; i < 6 && wrap; i++) { wrap = wrap.parentElement; if (wrap.querySelector('input')) break; }
      const inp = wrap?.querySelector('input');
      if (!inp) return;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, t);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, p.trial);
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: `${OUT}/plan-${p.handle}.png` });
  // save
  const nav = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
  await nav;
  await page.waitForTimeout(5000);
  log(p.handle, 'saved →', page.url());
}
await page.screenshot({ path: `${OUT}/49-plans-done.png` });
await ctx.close();
