import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const log = (...a) => console.log('[feat]', ...a);

const names = ['Free', 'Starter', 'Pro', 'Scale'];
const charges = { 1: '$8 per additional 1,000 messages', 2: '$5 per additional 1,000 messages', 3: '$3 per additional 1,000 messages' };
const features = [
  ['250 messages / month', 'All channels', 'Human takeover'],
  ['2,000 messages / month', 'All channels', 'Human takeover'],
  ['20,000 messages / month', 'All channels', 'Human takeover', 'Knowledge gaps tracking'],
  ['100,000 messages / month', 'All channels', 'Human takeover', 'Priority support'],
];
// mark plan cards
await page.evaluate(() => {
  for (let i = 0; i < 4; i++) {
    const inp = document.querySelector(`input[name="pricingChargeRecurring.pricingPlans.${i}.name"]`);
    let card = inp; for (let k = 0; k < 10 && card; k++) { card = card.parentElement; if (card.querySelector('button') && card.innerText.includes('top feature')) break; }
    card?.setAttribute('data-plancard', i);
  }
});
// refill names + charges (idempotent)
for (let i = 0; i < 4; i++) {
  const n = page.locator(`input[name="pricingChargeRecurring.pricingPlans.${i}.name"]`);
  if (await n.count()) await n.fill(names[i]);
  if (charges[i]) {
    const c = page.locator(`input[name="pricingChargeRecurring.pricingPlans.${i}.additionalChargesDescription"]`);
    if (await c.count()) await c.fill(charges[i]);
  }
}
// add features: click Add in card → fill the new empty unnamed input
for (let i = 0; i < 4; i++) {
  for (const f of features[i]) {
    const added = await page.evaluate((i) => {
      const card = document.querySelector(`[data-plancard="${i}"]`);
      const btn = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add');
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    }, i);
    await page.waitForTimeout(800);
    if (!added) { log('plan', i, 'no Add'); break; }
    await page.evaluate(({ i, f }) => {
      const card = document.querySelector(`[data-plancard="${i}"]`);
      const empties = [...card.querySelectorAll('input[type="text"]')].filter(x => !x.name && x.offsetParent !== null && !x.value);
      const inp = empties[empties.length - 1];
      if (!inp) return;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, f);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, { i, f });
    await page.waitForTimeout(400);
    log('plan', i, 'feature:', f);
  }
}
await page.screenshot({ path: `${OUT}/52-plans-filled.png` });
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
await page.waitForTimeout(8000);
log('after save:', await page.evaluate(() => (document.body.innerText.match(/(\d+) issues?/) || [])[0] ?? 'no-issue-label'));
await page.screenshot({ path: `${OUT}/53-final.png` });
await ctx.close();
