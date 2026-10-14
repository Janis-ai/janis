// Headed browse — opens the real hosted messenger in a VISIBLE Chromium
// window and types a scripted conversation so you can watch Janis reply.
//   node scripts/ui/browse.mjs            → Shopify storefront channel
//   UI_URL=https://… node scripts/ui/browse.mjs   → another hosted page
//   UI_SLOW_MS=200 node scripts/ui/browse.mjs     → slower, easier to watch
// The window stays open afterwards — keep poking the widget yourself.

import { chromium } from 'playwright';

const URL_ =
  process.env.UI_URL ??
  'https://app.janis.ai/chat/dd416836-710e-4be7-806e-b2196669e1c5/page';
const SLOW = Number(process.env.UI_SLOW_MS ?? 90);
const TYPE_DELAY = Number(process.env.UI_TYPE_MS ?? 35);
const HOLD = Number(process.env.UI_HOLD_MS ?? 3500);

const TURNS = [
  'show me your products',
  'can i get the gift card?',
  'do you have the hidden snowboard?',
  'show me every product you have',
  'show me the rest',
  'i want to buy the videographer snowboard',
];

const browser = await chromium.launch({ headless: false, slowMo: SLOW });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
console.log(`[browse] opening ${URL_}`);
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#janis-input', { timeout: 30_000 });
await page.waitForTimeout(2500); // greeting lands

const outCount = () => page.locator('.janis-msg.out').count();

// debug: catch reloads, request bodies, and console errors
page.on('framenavigated', (f) => {
  if (f === page.mainFrame()) console.log('[browse] NAVIGATED →', f.url());
});
page.on('pageerror', (e) => console.log('[browse] pageerror:', e.message));
page.on('request', (r) => {
  if (r.method() === 'POST' && r.url().includes('/messages'))
    console.log('[browse] POST body:', r.postData()?.slice(0, 120));
});

for (const text of TURNS) {
  const before = await outCount();
  console.log(`[browse] typing: ${text}`);
  const input = page.locator('#janis-input');
  await input.click();
  await input.pressSequentially(text, { delay: TYPE_DELAY });
  await page.waitForTimeout(400);
  console.log(`[browse] input value at send: ${JSON.stringify(await input.inputValue())}`);
  await page.locator('#janis-send').click();
  // wait for the AGENT's bubble (your own .in bubble doesn't count), then a
  // quiet period so widgets/chips finish rendering before the next turn —
  // rapid-fire sends coalesce mid-run and replies lag behind what you see.
  try {
    await page.waitForFunction(
      (n) => document.querySelectorAll('.janis-msg.out').length > n,
      before,
      { timeout: 60_000, polling: 500 },
    );
    await page.waitForFunction(
      (n) => document.querySelectorAll('.janis-msg.out').length === n,
      await outCount(),
      { timeout: 8_000, polling: 1000 },
    ).catch(() => {});
    await page.waitForTimeout(1500);
  } catch {
    console.warn('[browse] no reply within 60s — continuing');
  }
  console.log('[browse] reply landed — pausing so you can watch');
  await page.waitForTimeout(HOLD);
}

console.log('[browse] script done — the window stays open, go ahead and poke it');
await new Promise(() => {}); // hold open until you close the window
