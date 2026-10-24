// Product demo film — segments per docs/marketing/demo-script.md.
//   SNOW_TOKEN=<session> SHOP_PASS=… node scripts/ui/product-demo.mjs
//   ONLY=seg2 node scripts/ui/product-demo.mjs    (single segment)
// Output: /tmp/janis-demo/seg-*.webm → concat + grade via ffmpeg.
//
// Playwright records no OS cursor — CURSOR_JS injects a fake one that
// tracks CDP mouse events (page.mouse.move fires real mousemove), with a
// click pulse. Typing is char-by-char via keyboard.type, never fill().

import { chromium } from 'playwright';
import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SHOP = 'https://snowboardsareus.myshopify.com';
const APP = 'https://app.janis.ai';
const SHOP_PASS = process.env.SHOP_PASS ?? '';
const TOKEN = process.env.SNOW_TOKEN;
const VID = '/tmp/janis-demo';
mkdirSync(VID, { recursive: true });

const CURSOR_JS = `
(() => {
  // init scripts run BEFORE the document parses — documentElement can be
  // null. Defer injection until the DOM exists (this silently killed the
  // cursor + captions in early takes).
  const boot = () => {
    if (!document.documentElement || document.getElementById('__demo-cursor')) return;
    const el = document.createElement('div');
    el.id = '__demo-cursor';
    Object.assign(el.style, {
      position: 'fixed', width: '14px', height: '14px', borderRadius: '50%',
      border: '2px solid rgba(15,17,23,.85)', background: 'rgba(255,255,255,.65)',
      boxShadow: '0 1px 4px rgba(0,0,0,.35)', zIndex: 2147483647,
      pointerEvents: 'none', left: '-40px', top: '-40px',
      transition: 'transform .08s ease-out',
    });
    document.documentElement.appendChild(el);
    let x = -40, y = -40, cx = -40, cy = -40;
    addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; }, true);
    addEventListener('mousedown', () => { el.style.transform = 'scale(.7)'; }, true);
    addEventListener('mouseup', () => { el.style.transform = 'scale(1)'; }, true);
    (function loop() {
      cx += (x - cx) * .35; cy += (y - cy) * .35;
      el.style.left = (cx - 7) + 'px'; el.style.top = (cy - 7) + 'px';
      requestAnimationFrame(loop);
    })();

    // narration caption bar — window.__cap('line') shows it, __cap('') hides.
    // Baked into the video itself: perfectly synced, no ffmpeg needed.
    const cap = document.createElement('div');
    cap.id = '__demo-caption';
    Object.assign(cap.style, {
      position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)',
      maxWidth: '1180px', padding: '14px 26px', borderRadius: '14px',
      background: 'rgba(12,13,16,.85)', color: '#fff',
      font: '500 26px/1.35 -apple-system, system-ui, sans-serif',
      textAlign: 'center', letterSpacing: '.1px',
      zIndex: 2147483646, pointerEvents: 'none', opacity: '0',
      transition: 'opacity .35s ease',
    });
    document.documentElement.appendChild(cap);
    window.__cap = (t) => {
      cap.textContent = t || '';
      cap.style.opacity = t ? '1' : '0';
    };
  };
  if (document.documentElement) boot();
  else addEventListener('DOMContentLoaded', boot, { once: true });
})();
`;

const browser = await chromium.launch({ headless: true });

const seg = async (name, fn, cookie) => {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    recordVideo: { dir: VID, size: { width: 1600, height: 1000 } },
  });
  await ctx.addInitScript(CURSOR_JS);
  await ctx.addInitScript(`localStorage.setItem('janis_theme', 'light')`);
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
    const files = readdirSync(VID)
      .filter((f) => f.endsWith('.webm') && !f.startsWith('seg-'))
      .map((f) => ({ f, t: statSync(join(VID, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (files[0]) renameSync(join(VID, files[0].f), join(VID, `${name}.webm`));
    console.log('seg', name);
  }
};

// --- helpers ---------------------------------------------------------------

/** Show a narration caption on screen (empty string hides it). */
const cap = (page, text) => page.evaluate((t) => window.__cap?.(t), text);

/** Move the (fake) cursor to an element, pause, click — reads as deliberate. */
const clickAt = async (page, locator, pause = 350) => {
  const box = await locator.boundingBox();
  if (box) {
    const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(target.x, target.y, { steps: 18 });
    await page.waitForTimeout(pause);
  }
  await locator.click();
};

/** Type like a person — focus the field, then keyboard, ~55ms jitter. */
const typeIn = async (page, selector, text) => {
  const el = page.locator(selector).first();
  await clickAt(page, el, 250);
  await page.keyboard.type(text, { delay: 55 });
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

/** Visitor says something and we wait for the agent's reply bubble. */
const say = async (page, text) => {
  const before = await agentMsgs(page);
  await typeIn(page, '#janis-input', text);
  await page.waitForTimeout(300);
  await page.press('#janis-input', 'Enter');
  console.log('said:', text);
  await page.waitForFunction(
    (b) => document.querySelectorAll('#janis-msgs .janis-msg:not(.janis-me)').length > b,
    before,
    { timeout: 150000 },
  );
  await settle(page);
  await page.waitForTimeout(1800); // beat for viewers
};

// --- seg 1: storefront visitor chat (S1+S2) ---------------------------------
if (!process.env.ONLY || process.env.ONLY === 'seg1')
await seg('seg1-storefront', async (page) => {
  await page.goto(SHOP, { waitUntil: 'domcontentloaded' });
  if (await page.locator('input[type="password"]').count()) {
    await typeIn(page, 'input[type="password"]', SHOP_PASS);
    await page.waitForTimeout(400);
    await clickAt(page, page.locator('button[type="submit"], input[type="submit"]').first());
    await page.waitForLoadState('domcontentloaded');
  }
  await page.waitForSelector('#janis-bubble', { timeout: 30000 });
  // cap() before goto lands on about:blank — set on the real document
  await cap(page, 'Live product, real storefront, real traffic \u2014 nothing staged.');
  await page.waitForTimeout(3500);

  await cap(page, 'Janis: AI agents that run customer conversations end‑to‑end — with humans in the loop.');
  await clickAt(page, page.locator('#janis-bubble'), 500);
  await page.waitForSelector('#janis-input', { timeout: 10000 });
  await page.waitForTimeout(2000);

  await cap(page, 'Answers come from the merchant\u2019s real catalog \u2014 products, prices, collections \u2014 inside the chat.');
  await say(page, 'Show me the snowboards you have for sale');
  if (!(await page.locator('.janis-wcards').count())) {
    await say(page, 'yes');
    await page.waitForSelector('.janis-wcards', { timeout: 90000 }).catch(() => {});
  }
  await page.waitForTimeout(2000);

  // drill into a collection so real product cards (image/price/buttons) show
  await cap(page, 'Commerce happens in\u2011conversation: product cards, add\u2011to\u2011cart, checkout \u2014 no redirect.');
  const coll = page.locator('.janis-wcards a, .janis-wcards button, .janis-wcards [class*="card"]').first();
  if (await coll.count()) {
    await clickAt(page, coll, 500);
    await settle(page);
    await page.waitForTimeout(2500);
  } else {
    await say(page, 'the snowboard collection');
  }

  await cap(page, 'Structured intake built in \u2014 it collects what it needs without forms or email tag.');
  await say(page, "what size board should I get? I'm 5'10\", 170lb");
  await page.waitForTimeout(1500);

  await cap(page, 'It closes the sale in the thread \u2014 conversion, not deflection.');
  await say(page, "I'll take the first one you showed me");
  await page.waitForTimeout(1500);

  // S2 — the moment AI should stop
  await cap(page, 'The hard part isn\u2019t AI answering \u2014 it\u2019s knowing when to stop.');
  await say(page, 'Actually the board I got last month is cracked and I want a refund');
  await cap(page, 'Escalation is a first\u2011class primitive: sentiment flags, structured intake, clean handoff.');
  await page.waitForTimeout(3500);
  await cap(page, '');
});

// --- seg 2: console inbox — the human end (S3) ------------------------------
if (!process.env.ONLY || process.env.ONLY === 'seg2')
await seg('seg2-inbox', async (page) => {
  await page.goto(`${APP}/conversations`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a.conv-row, [class*="conv"]', { timeout: 20000 });
  await page.click('.push-banner-dismiss').catch(() => {});
  await cap(page, 'Same thread, operator side \u2014 human takeover is native, not a bolt\u2011on.');
  await page.waitForTimeout(2000);
  // newest thread = the visitor conversation seg1 just created
  await clickAt(page, page.locator('a.conv-row').first(), 600);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2500);

  const takeOver = page.locator('button', { hasText: 'Take over' }).first();
  if (await takeOver.count()) {
    await clickAt(page, takeOver, 800);
    await page.waitForTimeout(1500);
  }
  // human reply — same thread, customer never knows a handoff happened.
  // NB: the transcript's collect-form preview has textareas too — target
  // the composer by its placeholder, never .last().
  await typeIn(page, 'textarea[placeholder*="Reply as a human"]', "Hi! Maya here from SnowboardsAreUs — so sorry the board arrived cracked. I'm shipping a replacement today and emailing you a prepaid return label. You don't need to do anything else.");
  await page.waitForTimeout(600);
  await cap(page, 'One conversation, one thread \u2014 the handoff is invisible to the customer.');
  await clickAt(page, page.getByRole('button', { name: 'Send', exact: true }), 400);
  await page.waitForTimeout(3000);
  await cap(page, '');
}, TOKEN);

// --- seg 3: rescue → learn loop (S4) ----------------------------------------
if (!process.env.ONLY || process.env.ONLY === 'seg3')
await seg('seg3-teach', async (page) => {
  await page.goto(`${APP}/conversations`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a.conv-row', { timeout: 20000 });
  await page.click('.push-banner-dismiss').catch(() => {});
  await cap(page, 'That\u2019s the moat \u2014 every human rescue becomes a regression test the agent is checked against.');
  await clickAt(page, page.locator('a.conv-row').first(), 600);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  // hand the thread back to the AI first — Teach agent only shows when
  // the agent owns the conversation (post-takeover it's hidden)
  const resume = page.locator('button', { hasText: 'Resume agent' }).first();
  if (await resume.count()) {
    await clickAt(page, resume, 700);
    await page.waitForTimeout(4000);
  }
  let teach = page.locator('button', { hasText: 'Teach agent' }).first();
  // still human-owned (resume pending/failed)? walk conv rows for an
  // AI-owned thread instead — the beat is Teach, not this specific conv
  for (let i = 1; !(await teach.count()) && i < 5; i++) {
    const rows = page.locator('a.conv-row');
    if (await rows.count() <= i) break;
    await page.goto(`${APP}/conversations`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a.conv-row', { timeout: 15000 });
    await clickAt(page, rows.nth(i), 500);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    teach = page.locator('button', { hasText: 'Teach agent' }).first();
  }
  if (await teach.count()) {
    await clickAt(page, teach, 700);
    await page.waitForTimeout(4000); // let the teach surface open/settle
  } else {
    console.log('no Teach agent button — skipped');
  }
  await cap(page, '');
}, TOKEN);

// --- seg 4: builder montage (S5) --------------------------------------------
if (!process.env.ONLY || process.env.ONLY === 'seg4')
await seg('seg4-builder', async (page) => {
  await page.goto(`${APP}/agents/new`, { waitUntil: 'domcontentloaded' });
  await page.click('.push-banner-dismiss').catch(() => {});
  await cap(page, 'Time\u2011to\u2011value is one sentence \u2014 describe the job, the LLM drafts the agent.');
  await page.waitForTimeout(2500);
  // chooser first: "Build an agent with Janis" enters the staged builder
  const build = page.locator('text=Build an agent with Janis').first();
  if (await build.count()) {
    await clickAt(page, build, 600);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
  }
  // Create stage: purpose textarea first, optional name, then Create —
  // the LLM drafts the config live ("Building agent…" is a good beat)
  const descIn = page.locator('textarea').first();
  if (await descIn.count()) {
    await typeIn(page, 'textarea', 'Answer customer questions about our hiking gear — sizing, availability, order status and returns — and help them check out.');
    await page.waitForTimeout(800);
  }
  // names must be unique workspace-wide — retry list in case a prior
  // take left one reserved (soft-deleted agents still hold the name)
  const NAMES = ['Alpine Provisions Co', 'Basecamp Gear Supply', 'Glacier Peak Outfitters', 'Timberline Trading'];
  const createBtn = page.locator('button', { hasText: 'Create agent' }).first();
  if (await createBtn.count()) {
    let created = false;
    for (const nm of NAMES) {
      await page.locator('input').first().fill('');
      await typeIn(page, 'input', nm);
      await page.waitForTimeout(600);
      await clickAt(page, createBtn, 600);
      const clash = await page.waitForSelector("text=already an agent's name", { timeout: 4000 }).catch(() => null);
      if (!clash) { created = true; break; }
      await page.waitForTimeout(800);
    }
    if (created) {
      // LLM draft can take a while — let it build
      await page.waitForSelector('text=Building agent', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(25000);
    }
  }
  await cap(page, 'Six guided stages \u2014 Create, Teach, Guide, Abilities, Try, Deploy. Fully self\u2011serve.');
  // click through the stage rail for the montage
  for (const label of ['Teach it', 'Guide it', 'Abilities', 'Try it', 'Deploy']) {
    const t = page.locator('.builder-step', { hasText: label }).first();
    if (await t.count() && await t.isEnabled()) {
      await clickAt(page, t, 500);
      await page.waitForTimeout(2800);
    }
  }
  await cap(page, '');
}, TOKEN);

// --- seg 5: deploy + landing (S6+S7) -----------------------------------------
if (!process.env.ONLY || process.env.ONLY === 'seg5')
await seg('seg5-deploy-landing', async (page) => {
  await page.goto(`${APP}/agents/51a81b16-f6a1-4dfa-ac83-15e116690269`, { waitUntil: 'domcontentloaded' });
  await cap(page, '94% of conversations resolve without a human \u2014 real usage, real leverage.');
  await page.waitForTimeout(3000);
  await page.click('.push-banner-dismiss').catch(() => {});
  await cap(page, 'One agent, every channel \u2014 web, Shopify, Meta, email, Slack, SMS, voice. One inbox.');
  await page.waitForTimeout(3000);
  // landing close — caption lives in the DOM, so set it AFTER the nav
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await cap(page, 'AI when AI is best. Humans when humans are needed. janis.ai');
  await page.waitForTimeout(3500);
  await cap(page, '');
}, TOKEN);

await browser.close();
console.log('done — segments in', VID);
