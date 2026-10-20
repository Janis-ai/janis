import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const info = await page.evaluate(() => {
  const ms = document.querySelector('[class*="ParamMultiSelect"]');
  if (!ms) return { found: false };
  const r = ms.getBoundingClientRect();
  const inputs = [...ms.querySelectorAll('input')].map(i => ({ t: i.type, ph: i.placeholder, vis: !!i.offsetParent }));
  const btns = [...ms.querySelectorAll('button, [role="button"], [tabindex]')].map(b => ({ tag: b.tagName, txt: b.textContent.trim().slice(0, 40), vis: !!b.offsetParent })).slice(0, 10);
  return { found: true, y: r.y + window.scrollY, h: r.height, cls: ms.className.slice(0, 80), inputs, btns, html: ms.outerHTML.slice(0, 600) };
});
console.log(JSON.stringify(info, null, 1));
await ctx.close();
