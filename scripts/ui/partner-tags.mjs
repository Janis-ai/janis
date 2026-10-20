import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const inp = page.locator('input[placeholder="Example: AI chatbots, Live chat, SMS"]');
await inp.scrollIntoViewIfNeeded();
await inp.click();
await inp.pressSequentially('Live chat', { delay: 50 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/34-tag-typed.png` });
// dump what appeared below the input
const opts = await page.evaluate(() => {
  const el = [...document.querySelectorAll('input')].find(i => i.placeholder.includes('AI chatbots'));
  let wrap = el; for (let i = 0; i < 8 && wrap; i++) wrap = wrap.parentElement;
  const visible = [...wrap.querySelectorAll('li, [role="option"], label')].filter(e => e.offsetParent !== null).map(e => e.textContent.trim().slice(0, 80));
  const pop = [...document.querySelectorAll('[class*="Popover"], [role="listbox"], [class*="OptionList"]')].filter(e => e.offsetParent !== null).map(e => e.innerText.slice(0, 400));
  return { visible: visible.slice(0, 15), pop: pop.slice(0, 3) };
});
console.log(JSON.stringify(opts, null, 1));
await ctx.close();
