import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const log = (...a) => console.log('[pd]', ...a);

const names = ['Free', 'Starter', 'Pro', 'Scale'];
const charges = { 1: '$8 per additional 1,000 messages', 2: '$5 per additional 1,000 messages', 3: '$3 per additional 1,000 messages' };
for (let i = 0; i < 4; i++) {
  await page.locator(`input[name="pricingChargeRecurring.pricingPlans.${i}.name"]`).fill(names[i]);
  if (charges[i]) await page.locator(`input[name="pricingChargeRecurring.pricingPlans.${i}.additionalChargesDescription"]`).fill(charges[i]);
}
log('names + charges filled');

// probe the plan "Add" (features) on plan 0
const probe = await page.evaluate(() => {
  const inp = document.querySelector('input[name="pricingChargeRecurring.pricingPlans.0.name"]');
  let card = inp; for (let i = 0; i < 10 && card; i++) { card = card.parentElement; if (card.querySelector('button')) break; }
  const btns = [...card.querySelectorAll('button')].map(b => b.textContent.trim());
  return btns;
});
log('plan0 buttons:', JSON.stringify(probe));
// click the "Add" inside plan0 card and see what appears
await page.evaluate(() => {
  const inp = document.querySelector('input[name="pricingChargeRecurring.pricingPlans.0.name"]');
  let card = inp; for (let i = 0; i < 10 && card; i++) { card = card.parentElement; if ([...card.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add')) break; }
  [...card.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add')?.click();
});
await page.waitForTimeout(1500);
const after = await page.evaluate(() => [...document.querySelectorAll('input,textarea')].filter(i => /plan/i.test(i.name) || i.offsetParent !== null).filter(i => i.name.includes('pricingPlans.0')).map(i => ({ n: i.name, ph: i.placeholder })));
log('plan0 fields after Add:', JSON.stringify(after));
await page.screenshot({ path: `${OUT}/51-plan-add.png` });
await ctx.close();
