import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);

const details = `Janis is an AI customer-support agent that lives in a chat bubble on your storefront. It answers shoppers instantly, pulls live data from your catalog and orders, and escalates to your team when a human should step in.

Recommendations render as rich product cards with add-to-cart links. Order lookups verify the customer by email code first. Monitor live chats and take over anytime — one inbox for web chat, Messenger, Instagram, WhatsApp, and email.`;
console.log('details len:', details.length);
await page.locator('textarea[name="appDetails"]').fill(details);

const feats = [
  'Instant answers with live catalog and order data',
  'Human takeover — one inbox across every channel',
  'Verified order lookups and guided return flows',
];
for (let i = 0; i < 3; i++) {
  console.log('feat', i, 'len:', feats[i].length);
  await page.locator(`textarea[name="featureList.${i}.description"]`).fill(feats[i]);
}

const meta = 'AI agent for your storefront — answers shoppers, recommends products, looks up orders, and hands off to your team. One inbox for every channel.';
console.log('meta len:', meta.length);
await page.locator('textarea[name="metaDescription"]').fill(meta);

await page.waitForTimeout(800);
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
await page.waitForTimeout(7000);
console.log('after save:', await page.evaluate(() => (document.body.innerText.match(/(\d+) issues?/) || [])[0] ?? 'no issues'));
// verify counters
const check = await page.evaluate(() => ['appDetails', 'featureList.0.description', 'featureList.1.description', 'featureList.2.description', 'metaDescription'].map(n => {
  const i = document.querySelector(`[name="${n}"]`);
  let card = i; for (let k = 0; k < 8 && card; k++) { card = card.parentElement; if (card?.innerText.match(/\d+\s*\/\s*\d+/)) break; }
  return n + ': ' + i.value.length + ' ' + (card?.innerText.match(/\d+\s*\/\s*\d+/)?.[0] ?? '');
}));
console.log(check.join('\n'));
await ctx.close();
