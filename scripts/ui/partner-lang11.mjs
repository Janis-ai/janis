import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator('.param-multi-select-languages > button').scrollIntoViewIfNeeded();
await page.locator('.param-multi-select-languages > button').click();
await page.waitForTimeout(1500);
const r = await page.evaluate(() => {
  const setVal = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const ms = document.querySelector('.param-multi-select-languages');
  const search = ms.querySelector('input[type="search"], input[placeholder*="earch"]');
  if (!search) return { step: 'no-search' };
  setVal(search, 'English');
  return { step: 'searched' };
});
console.log(JSON.stringify(r));
await page.waitForTimeout(1500);
const r2 = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('.param-multi-select-languages label')];
  const en = labels.find(l => l.textContent.trim() === 'English');
  if (!en) return { step: 'no-option', opts: labels.map(l => l.textContent.trim()).slice(0, 10) };
  en.click();
  return { step: 'clicked' };
});
console.log(JSON.stringify(r2));
await page.waitForTimeout(1000);
const st = await page.evaluate(() => {
  const cbs = [...document.querySelectorAll('input[type="checkbox"]')];
  const en = cbs.find(c => (c.closest('label') ?? c.parentElement?.querySelector('label'))?.textContent.trim() === 'English');
  return en?.checked;
});
console.log('checked:', st);
await page.screenshot({ path: `${OUT}/24-lang-picked.png` });
await ctx.close();
