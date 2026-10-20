import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const out = {};
// type into first category-detail input, watch for suggestion UI
const inp = page.locator('input[placeholder="Example: AI chatbots, Live chat, SMS"]');
await inp.scrollIntoViewIfNeeded();
await inp.click();
await inp.pressSequentially('Live', { delay: 60 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/33-tag-probe.png` });
out.tagProbe = await page.evaluate(() => {
  const popups = [...document.querySelectorAll('[role="listbox"], [role="dialog"], [class*="Popover"], [class*="Autocomplete"], ul')].map(p => ({
    role: p.getAttribute('role'), cls: p.className.toString().slice(0, 60), txt: p.innerText.slice(0, 300), vis: p.offsetParent !== null,
  })).filter(p => p.vis && p.txt);
  return popups.slice(0, 6);
});
await page.keyboard.press('Escape');
// sales channel checkbox labels
out.salesBoxes = await page.evaluate(() => {
  const sec = [...document.querySelectorAll('input[name="salesChannelRequiredSelection"], input[name="noSalesChannelRequiredSelection"]')];
  return sec.map(r => {
    let card = r; for (let i = 0; i < 6 && card; i++) card = card.parentElement;
    const boxes = [...card.querySelectorAll('input[type="checkbox"]')].map(c => c.closest('label')?.textContent.trim().slice(0, 120));
    return { radio: r.name, label: r.closest('label')?.textContent.trim().slice(0, 100), boxes };
  });
});
// pricing section — find heading and the card that follows it
out.pricing = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3')].find(x => x.textContent.trim() === 'Pricing details');
  if (!h) return null;
  // the section is a sibling block after the heading's column
  let grid = h.parentElement?.parentElement?.parentElement;
  const scope = grid ?? h.parentElement;
  const ctrls = [...scope.querySelectorAll('input,textarea,button,select')].map(c => ({
    t: c.tagName.toLowerCase(), ty: c.type || '', n: c.name || '', ph: c.placeholder || '', x: (c.textContent || '').trim().slice(0, 60), v: c.offsetParent !== null,
  })).filter(c => c.v);
  return { text: scope.innerText.slice(0, 2000), ctrls };
});
fs.writeFileSync('/tmp/partner/probe.json', JSON.stringify(out, null, 1));
console.log('done');
await ctx.close();
