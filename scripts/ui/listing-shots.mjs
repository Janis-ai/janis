// Listing screenshots — drives the REAL snowboardsareus storefront:
// storefront password auth → live theme + app-embed widget → conversation.
//   node scripts/ui/listing-shots.mjs   → PNGs in scripts/ui/out/
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOP = process.env.SHOP ?? 'https://snowboardsareus.myshopify.com';
const SHOP_PASS = process.env.SHOP_PASS ?? ''; // dev-store storefront password
const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
let n = 0;
const shot = async (name) => {
  const f = join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f });
  console.log('shot:', f);
};
const agentMsgs = () =>
  page.locator('#janis-msgs .janis-msg:not(.janis-me)').count();
const scrollEnd = () =>
  page.evaluate(() => {
    const el = document.querySelector('#janis-msgs');
    if (el) el.scrollTop = el.scrollHeight;
  });
const settle = async () => {
  // DOM stable for ~4s AND no typing indicator — covers poll cadence,
  // late acks, and tool-call tails (draft orders take a while)
  let last = '';
  for (let i = 0; i < 40; i++) {
    const cur = await page.evaluate(
      () => (document.querySelector('#janis-msgs')?.innerHTML ?? ''),
    );
    const typing = await page.evaluate(
      () => !!document.querySelector('#janis-msgs [class*="typing"], #janis-msgs .janis-typing'),
    );
    if (cur === last && !typing) { await scrollEnd(); return; }
    last = cur;
    await page.waitForTimeout(4000);
  }
  await scrollEnd();
};
const say = async (text) => {
  const before = await agentMsgs();
  await page.fill('#janis-input', text);
  await page.press('#janis-input', 'Enter');
  console.log('said:', text);
  await page.waitForFunction(
    (b) => document.querySelectorAll('#janis-msgs .janis-msg:not(.janis-me)').length > b,
    before,
    { timeout: 150000 },
  );
  await settle();
};

try {
  await page.goto(SHOP, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/password')) {
    if (!SHOP_PASS) throw new Error('SHOP_PASS unset — dev-store storefront password required');
    await page.fill('input[name="password"]', SHOP_PASS);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
  }
  await page.waitForSelector('#janis-bubble', { timeout: 30000 });
  await shot('storefront-bubble');
  await page.click('#janis-bubble');
  await page.waitForSelector('#janis-input', { timeout: 10000 });
  await page.waitForTimeout(3000);
  await shot('chat-open');

  // 1 — product cards (a direct browse ask reliably fires the search tool;
  //     nudge 'yes' if the first reply stays prose)
  await say('Show me the snowboards you have for sale');
  if (!(await page.locator('.janis-wcards').count())) {
    await say('yes');
    await page.waitForSelector('.janis-wcards', { timeout: 90000 });
    await page.waitForTimeout(1500);
  }
  await shot('product-cards');

  // 2 — collect form (board_fit trigger — same phrasing that fired it live)
  await say("what size board should I get? I'm 5'10\", 170lb");
  if (!(await page.locator('.janis-wform').count())) {
    await say('can I just fill in my details in a form?');
    await page.waitForSelector('.janis-wform', { timeout: 90000 });
    await page.waitForTimeout(1500);
  }
  await shot('collect-form');

  const form = page.locator('.janis-wform').last();
  const fields = form.locator('input, textarea, select');
  const count = await fields.count();
  const values = ['mike@example.com', '5 ft 10 in', '170 lb'];
  for (let i = 0, v = 0; i < count && v < values.length; i++) {
    const f = fields.nth(i);
    if ((await f.evaluate((el) => el.tagName)) === 'SELECT') await f.selectOption({ index: 1 });
    else { await f.fill(values[v]); v++; }
  }
  await shot('collect-form-filled');
  await form.locator('button[type="submit"], button').last().click();
  await settle(); // submit lands → agent acknowledges with a recommendation
  await shot('collect-form-sent');

  // 3 — buy flow → draft order. The agent may ask for an email first
  // (draft-order needs a customer) — answer it, then shoot the pay link.
  await say('I want to buy the first board you showed me');
  if (!(await page.locator('#janis-msgs a[href*="checkout"], #janis-msgs a[href*="cart"]').count())) {
    await say('my email is mike@example.com');
    await settle();
  }
  await shot('buy-flow');

  // 4 — procedure: return request (stepwise runbook). One follow-up turn so
  // the screenshot catches it mid-procedure (asking/verifying).
  await say('Actually I need to return an order I already received');
  await shot('procedure-return-ask');
  await say('the order was for the Hydrogen board, email mike@example.com');
  await shot('procedure-return');
} catch (e) {
  console.log('ERR:', e.message);
  await shot('error-state');
} finally {
  await browser.close();
}
