import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const terms = ['Slack', 'WhatsApp', 'Instagram', 'Facebook Messenger', 'Zendesk', 'HubSpot'];
for (const t of terms) {
  await page.evaluate((t) => {
    const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Integrations (optional)');
    let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input[type="text"]')) break; }
    const inp = [...c.querySelectorAll('input[type="text"]')].find(i => i.offsetParent !== null);
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, t);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }, t);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Integrations (optional)');
    let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('button')) break; }
    [...c.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add' && !b.disabled)?.click();
  });
  await page.waitForTimeout(800);
  console.log('added:', t);
}
await page.screenshot({ path: `${OUT}/68-integ.png` });
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
await page.waitForTimeout(6000);
console.log('after save:', await page.evaluate(() => (document.body.innerText.match(/(\d+) issues?/) || [])[0] ?? 'no issues'));
await ctx.close();
