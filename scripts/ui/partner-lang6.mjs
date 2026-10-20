import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const pos = await page.evaluate(() => {
  const en = document.querySelector('input[id=":r11:"]');
  if (!en) return { found: false };
  const r = en.getBoundingClientRect();
  const st = getComputedStyle(en);
  // what ancestor has scrollable overflow?
  let el = en; let container = '';
  while (el && el !== document.body) {
    const s = getComputedStyle(el);
    if (s.overflowY === 'auto' || s.overflowY === 'scroll') { container = el.className.slice(0, 80); break; }
    el = el.parentElement;
  }
  return { found: true, x: r.x, y: r.y, w: r.width, h: r.height, display: st.display, visibility: st.visibility, opacity: st.opacity, scrollContainer: container, docY: r.y + window.scrollY };
});
console.log(JSON.stringify(pos));
await ctx.close();
