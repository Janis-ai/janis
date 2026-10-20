import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const r = await page.evaluate(() => {
  const fields = [];
  document.querySelectorAll('input[name], textarea[name], select[name]').forEach((el) => {
    fields.push({ name: el.name, tag: el.tagName.toLowerCase(), type: el.type, val: (el.value ?? '').slice(0, 60), disabled: el.disabled });
  });
  const heads = [...document.querySelectorAll('h1, h2, h3, legend')].map(h => h.textContent.trim().slice(0, 60));
  const navs = [...document.querySelectorAll('a')].map(a => a.textContent.trim()).filter(t => ['Basic app information','App store listing content','Pricing details','App discovery content','Install requirements','Tracking information','Contact information','App testing information'].includes(t));
  const buttons = [...document.querySelectorAll('button')].map(b => b.textContent.trim().slice(0, 40)).filter(Boolean);
  return { fields, heads, navs, buttons: [...new Set(buttons)] };
});
console.log(JSON.stringify(r, null, 1));
await ctx.close();
