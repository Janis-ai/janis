import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator('.param-multi-select-languages > button').scrollIntoViewIfNeeded();
await page.locator('.param-multi-select-languages > button').click();
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const s = document.querySelector('.param-multi-select-languages input[type="search"], .param-multi-select-languages input[placeholder*="earch"]');
  setVal(s, 'English');
});
await page.waitForTimeout(1500);
const box = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.param-multi-select-languages label')].filter(l => l.textContent.trim() === 'English');
  const r = rows[0]?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
});
console.log('opt box:', JSON.stringify(box));
if (box) { await page.mouse.click(box.x, box.y); }
await page.waitForTimeout(1200);
const st = await page.evaluate(() => {
  const chips = [...document.querySelectorAll('.param-multi-select-languages [class*="Selected"], .param-multi-select-languages [class*="Tag"], .param-multi-select-languages [class*="Chip"]')].map(d => d.textContent.trim()).filter(Boolean);
  const cb = [...document.querySelectorAll('.param-multi-select-languages input[type="checkbox"]')].find(c => c.closest('label')?.textContent.trim() === 'English');
  return { chips, checked: cb?.checked };
});
console.log(JSON.stringify(st));
await page.screenshot({ path: `${OUT}/28-lang-click.png` });
await ctx.close();
