// Buy-flow screenshot — drives the real snowboardsareus widget through
// identity verification (code read back from prod DB) → draft order →
// pay-link card. Needs DATABASE_URL + SESSION_SECRET exported.
//   node scripts/ui/buy-flow-shot.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOP = process.env.SHOP ?? 'https://snowboardsareus.myshopify.com';
const SHOP_PASS = process.env.SHOP_PASS ?? '';
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
const agentMsgs = () => page.locator('#janis-msgs .janis-msg:not(.janis-me)').count();
const scrollEnd = () =>
  page.evaluate(() => {
    const el = document.querySelector('#janis-msgs');
    if (el) el.scrollTop = el.scrollHeight;
  });
const settle = async () => {
  let last = '';
  for (let i = 0; i < 45; i++) {
    const cur = await page.evaluate(() => document.querySelector('#janis-msgs')?.innerHTML ?? '');
    const typing = await page.evaluate(
      () => !!document.querySelector('#janis-msgs [class*="typing"], #janis-msgs .janis-typing'),
    );
    if (cur === last && !typing) { await scrollEnd(); return; }
    last = cur;
    await page.waitForTimeout(4000);
  }
  await scrollEnd();
};
const lastReply = async () =>
  (await page.locator('#janis-msgs .janis-msg:not(.janis-me)').last().textContent()) ?? '';
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
  return lastReply();
};

try {
  await page.goto(SHOP, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/password')) {
    if (!SHOP_PASS) throw new Error('SHOP_PASS unset');
    await page.fill('input[name="password"]', SHOP_PASS);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
  }
  await page.waitForSelector('#janis-bubble', { timeout: 30000 });
  await page.click('#janis-bubble');
  await page.waitForSelector('#janis-input', { timeout: 10000 });
  await page.waitForTimeout(3000);

  // cards first
  await say('Show me the snowboards you have for sale');
  if (!(await page.locator('.janis-wcards').count())) {
    await say('yes');
    await page.waitForSelector('.janis-wcards', { timeout: 90000 });
    await settle();
  }
  await shot('b-cards');

  // buy → likely gated on verified email
  let reply = await say('I want to buy the first board — my email is mike@example.com');
  if (/code|verif/i.test(reply)) {
    const out = execFileSync('npx', ['tsx', 'apps/api/scripts/tmp/get-verify-code.ts'], {
      cwd: new URL('../..', import.meta.url).pathname,
      encoding: 'utf8',
      env: process.env,
    });
    const code = out.match(/CODE=(\d{6})/)?.[1];
    console.log('verify code:', code ?? '(none — ' + out.trim() + ')');
    if (code) reply = await say(`the code is ${code}`);
  }
  // draft order may need an extra nudge if the reply just confirms identity
  if (!/checkout|pay|order/i.test(reply)) {
    reply = await say('go ahead and create the order');
    await settle();
  }
  await page.waitForTimeout(2000);
  await shot('b-buy-done');
} catch (e) {
  console.log('ERR:', e.message);
  await shot('b-error');
} finally {
  await browser.close();
}
