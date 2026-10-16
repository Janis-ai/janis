// Shopify review walkthrough video — records REAL surfaces:
//   seg1: embedded-app home (still → clip)   — the install beat
//   seg2: snowboardsareus storefront chat    — cards → collect form → buy → verify
//   seg3: console inbox                    — the same thread + takeover/note
//   SNOW_TOKEN=<minted session> SHOP_PASS=… node scripts/ui/demo-video.mjs
// Output: /tmp/janis-video/seg-*.webm → concat + grade via ffmpeg step.
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SHOP = 'https://snowboardsareus.myshopify.com';
const APP = 'https://app.janis.ai';
const SHOP_PASS = process.env.SHOP_PASS ?? '';
const TOKEN = process.env.SNOW_TOKEN;
const VID = '/tmp/janis-video';
mkdirSync(VID, { recursive: true });

const browser = await chromium.launch({ headless: true });

const seg = async (name, fn, cookie) => {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    recordVideo: { dir: VID, size: { width: 1600, height: 1000 } },
  });
  if (cookie) {
    await ctx.addCookies([{
      name: 'janis_session', value: cookie, domain: 'app.janis.ai', path: '/',
      httpOnly: true, secure: true, sameSite: 'Lax',
    }]);
  }
  const page = await ctx.newPage();
  try {
    await fn(page);
  } catch (e) {
    console.log(`${name} ERR:`, e.message);
  } finally {
    await ctx.close();
    // newest untagged webm in VID is this segment's recording
    const files = readdirSync(VID)
      .filter((f) => f.endsWith('.webm') && !f.startsWith('seg-'))
      .map((f) => ({ f, t: statSync(join(VID, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (files[0]) renameSync(join(VID, files[0].f), join(VID, `${name}.webm`));
    console.log('seg', name);
  }
};

const agentMsgs = (page) => page.locator('#janis-msgs .janis-msg:not(.janis-me)').count();
const scrollEnd = (page) => page.evaluate(() => {
  const el = document.querySelector('#janis-msgs');
  if (el) el.scrollTop = el.scrollHeight;
});
const settle = async (page) => {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const cur = await page.evaluate(() => document.querySelector('#janis-msgs')?.innerHTML ?? '');
    const typing = await page.evaluate(
      () => !!document.querySelector('#janis-msgs [class*="typing"], #janis-msgs .janis-typing'),
    );
    if (cur === last && !typing) { await scrollEnd(page); return; }
    last = cur;
    await page.waitForTimeout(4000);
  }
};
const say = async (page, text) => {
  const before = await agentMsgs(page);
  await page.fill('#janis-input', text);
  await page.press('#janis-input', 'Enter');
  console.log('said:', text);
  await page.waitForFunction(
    (b) => document.querySelectorAll('#janis-msgs .janis-msg:not(.janis-me)').length > b,
    before,
    { timeout: 150000 },
  );
  await settle(page);
  await page.waitForTimeout(1500); // beat for viewers
};

// --- seg 2: storefront chat -----------------------------------------------
if (!process.env.ONLY || process.env.ONLY === 'seg2')
await seg('seg2-storefront', async (page) => {
  await page.goto(SHOP, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/password')) {
    await page.fill('input[name="password"]', SHOP_PASS);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
  }
  await page.waitForSelector('#janis-bubble', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.click('#janis-bubble');
  await page.waitForSelector('#janis-input', { timeout: 10000 });
  await page.waitForTimeout(2500);

  await say(page, 'Show me the snowboards you have for sale');
  if (!(await page.locator('.janis-wcards').count())) {
    await say(page, 'yes');
    await page.waitForSelector('.janis-wcards', { timeout: 90000 }).catch(() => {});
  }
  await page.waitForTimeout(2000);

  await say(page, "what size board should I get? I'm 5'10\", 170lb");
  if (!(await page.locator('.janis-wform').count())) {
    await say(page, 'can I just fill in my details in a form?');
    await page.waitForSelector('.janis-wform', { timeout: 90000 }).catch(() => {});
  }
  const form = page.locator('.janis-wform').last();
  if (await form.count()) {
    const fields = form.locator('input, textarea, select');
    const count = await fields.count();
    const values = ['mike@example.com', '5 ft 10 in', '170 lb'];
    for (let i = 0, v = 0; i < count && v < values.length; i++) {
      const f = fields.nth(i);
      if ((await f.evaluate((el) => el.tagName)) === 'SELECT') await f.selectOption({ index: 1 });
      else { await f.fill(values[v]); v++; }
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1000);
    await form.locator('button[type="submit"], button').last().click();
    await settle(page);
  }
  await page.waitForTimeout(1500);

  await say(page, 'I want to buy the first board you showed me');
  if (!(await page.locator('#janis-msgs a[href*="checkout"], #janis-msgs a[href*="cart"]').count())) {
    await say(page, 'my email is mike@example.com');
  }
  await page.waitForTimeout(2000);

  await say(page, 'Actually I need to return an order I already received');
  await page.waitForTimeout(2500);
});

// --- seg 3: console inbox ---------------------------------------------------
let convId = null;
if (!process.env.ONLY || process.env.ONLY === 'seg3')
await seg('seg3-inbox', async (page) => {
  await page.goto(`${APP}/conversations`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a[href*="/conversations/"], [class*="conv"]', { timeout: 20000 });
  await page.click('.push-banner-dismiss').catch(() => {});
  await page.waitForTimeout(2500);
  const href = await page.locator('a[href*="/conversations/"]').first().getAttribute('href');
  convId = href?.split('/conversations/')[1]?.split(/[?#]/)[0] ?? null;
  if (href) await page.goto(APP + href, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('textarea, [class*="msg"]', { timeout: 20000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  // hover the action bar — takeover controls are the handoff story
  const note = page.locator('button:has-text("Internal note")');
  if (await note.count()) {
    await note.click();
    await page.waitForTimeout(1500);
    const ta = page.locator('textarea').last();
    if (await ta.count()) {
      await ta.fill('Following up on this one — draft order sent, watch for the payment.');
      await page.waitForTimeout(1200);
      // leave the note unsent — staging text in the composer reads fine
    }
  }
  await page.waitForTimeout(1500);
}, TOKEN);

await browser.close();
console.log('CONVID=' + (convId ?? 'none'));
console.log('segments in', VID);
