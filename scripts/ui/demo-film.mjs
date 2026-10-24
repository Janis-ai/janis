// Film rig for the Janis product demo — per-segment webm → ffmpeg concat.
// Builds on demo-video.mjs (Shopify review video). Adds the two things that
// keep headless footage from looking robotic:
//   - fake on-screen cursor — Playwright records no OS cursor, so every
//     click lands via an animated dot moving to the target first
//   - char-by-char typing with jittered delays — never fill() on camera
//
//   SNOW_TOKEN=<minted session> SHOP_PASS=… node scripts/ui/demo-film.mjs
//   ONLY=seg2 node scripts/ui/demo-film.mjs        # single segment
//
// Output: /tmp/janis-film/seg-*.webm + beats.json — captions render as a
// DOM overlay at beat() time (synced by construction, no libass needed);
// a plain ffmpeg concat produces the final mp4.
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHOP = process.env.SHOP ?? 'https://snowboardsareus.myshopify.com';
const APP = process.env.APP ?? 'https://app.janis.ai';
const AGENT = process.env.AGENT_ID ?? '51a81b16-f6a1-4dfa-ac83-15e116690269';
const SHOP_PASS = process.env.SHOP_PASS ?? '';
const TOKEN = process.env.SNOW_TOKEN;
const VID = process.env.VID_DIR ?? '/tmp/janis-film';
mkdirSync(VID, { recursive: true });

const browser = await chromium.launch({ headless: true });

// ---------------------------------------------------------------- cursor
const LIGHT = process.env.LIGHT !== '0'; // this cut ships light-mode console
const CURSOR_INIT = (light) => {
  if (light) try { localStorage.setItem('janis_theme', 'light'); } catch {}
  if (window !== window.top) return; // iframes get no duplicate cursor
  const mount = () => {
    if (document.getElementById('__filmcur')) return;
    const s = document.createElement('style');
    s.textContent = `
      #__filmcur{position:fixed;left:0;top:0;width:18px;height:18px;z-index:2147483647;
        pointer-events:none;transform:translate(64px,64px);
        transition:transform .38s cubic-bezier(.22,.8,.3,1)}
      #__filmcur .__d{width:100%;height:100%;border-radius:50%;
        background:rgba(24,26,32,.85);
        box-shadow:0 1px 5px rgba(0,0,0,.45),inset 0 0 0 2.5px rgba(255,255,255,.9);
        transition:scale .12s ease-out}
      #__filmcur.__down .__d{scale:.72}
      #__filmcap{position:fixed;left:50%;bottom:44px;transform:translateX(-50%);
        max-width:1080px;z-index:2147483647;pointer-events:none;text-align:center;
        font:600 27px/1.35 -apple-system,"Helvetica Neue",Arial,sans-serif;
        color:#fff;background:rgba(10,12,16,.66);padding:12px 26px;
        border-radius:12px;white-space:pre-line;opacity:0;
        transition:opacity .25s ease;text-wrap:balance}`;
    document.documentElement.appendChild(s);
    const c = document.createElement('div');
    c.id = '__filmcur';
    c.innerHTML = '<div class="__d"></div>';
    document.documentElement.appendChild(c);
    const cap = document.createElement('div');
    cap.id = '__filmcap';
    document.documentElement.appendChild(cap);
  };
  if (document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount);
};

/** Burn a caption into the frame — stays until the next beat or seg end.
 *  pos: 'bc' bottom-center (default) | 'bl' bottom-left (storefront — the
 *  expanded widget owns bottom-right) | 'up' raised center (conversation —
 *  keeps the composer clear while a reply types). */
async function caption(page, text, pos) {
  await page.evaluate(([t, p]) => {
    const c = document.getElementById('__filmcap');
    if (!c) return;
    if (p === 'bl') Object.assign(c.style, { left: '44px', right: 'auto', bottom: '44px', transform: 'none', textAlign: 'left', maxWidth: '820px' });
    else if (p === 'up') Object.assign(c.style, { left: '50%', right: 'auto', bottom: '170px', transform: 'translateX(-50%)', textAlign: 'center', maxWidth: '1080px' });
    else Object.assign(c.style, { left: '50%', right: 'auto', bottom: '44px', transform: 'translateX(-50%)', textAlign: 'center', maxWidth: '1080px' });
    c.style.opacity = t ? '1' : '0';
    if (t) c.textContent = t;
  }, [text ?? '', pos ?? 'bc']);
}

class Cursor {
  constructor(page) {
    this.page = page;
    this.x = 64;
    this.y = 64;
  }
  async _set(x, y, ms) {
    await this.page.evaluate(
      ([x, y, ms]) => {
        const c = document.getElementById('__filmcur');
        if (!c) return;
        c.style.transitionDuration = ms + 'ms';
        c.style.transform = `translate(${x - 9}px,${y - 9}px)`;
      },
      [x, y, ms],
    );
    this.x = x;
    this.y = y;
    if (ms) await this.page.waitForTimeout(ms + 40);
  }
  // distance-scaled glide to a point inside the target (slight human offset)
  async to(loc, ms) {
    const box = await loc.boundingBox();
    if (!box) return;
    const tx = box.x + box.width / 2 + (Math.random() * 8 - 4);
    const ty = box.y + box.height / 2 + (Math.random() * 6 - 3);
    const dist = Math.hypot(tx - this.x, ty - this.y);
    const dur = ms ?? Math.min(650, Math.max(240, dist * 0.55));
    await this._set(tx, ty, Math.round(dur));
  }
  async click(loc, opts = {}) {
    await this.to(loc, opts.ms);
    await this.page.evaluate(() => {
      const c = document.getElementById('__filmcur');
      c?.classList.add('__down');
      setTimeout(() => c?.classList.remove('__down'), 130);
    });
    await this.page.waitForTimeout(150);
    await loc.click();
    await this.page.waitForTimeout(250);
  }
}

// jittered per-char typing (pressSequentially only takes a fixed delay)
async function humanType(page, loc, text) {
  await loc.click();
  for (const ch of text) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(38 + Math.random() * 70);
  }
}

// ------------------------------------------------------------- segments
// Beat marks → beats.json → demo-subs.mjs times captions off them.
const BEATS = {};
const seg = async (name, fn, cookie) => {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    recordVideo: { dir: VID, size: { width: 1600, height: 1000 } },
  });
  await ctx.addInitScript(CURSOR_INIT, LIGHT);
  if (cookie) {
    await ctx.addCookies([{
      name: 'janis_session', value: cookie, domain: 'app.janis.ai', path: '/',
      httpOnly: true, secure: true, sameSite: 'Lax',
    }]);
  }
  const page = await ctx.newPage();
  const cur = new Cursor(page);
  const t0 = Date.now();
  const marks = (BEATS[name] = []);
  const beat = (n, cap, pos) => {
    marks.push({ n, t: Date.now() - t0 });
    if (cap !== undefined) void caption(page, cap, pos);
  };
  try {
    await fn(page, cur, beat);
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

// -------------------------------------------------- widget chat helpers
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
const say = async (page, cur, text) => {
  const before = await agentMsgs(page);
  const input = page.locator('#janis-input');
  await cur.click(input);
  await humanType(page, input, text);
  await page.waitForTimeout(300);
  await page.press('#janis-input', 'Enter');
  console.log('said:', text);
  await page.waitForFunction(
    (b) => document.querySelectorAll('#janis-msgs .janis-msg:not(.janis-me)').length > b,
    before,
    { timeout: 150000 },
  );
  await settle(page);
  await page.waitForTimeout(1500);
};

const ONLY = process.env.ONLY;

// kill console chrome that isn't the story — push banner, cookie bars
const tidy = async (page) => {
  await page.click('.push-banner-dismiss').catch(() => {});
};

// ==== seg1: storefront — the customer side =============================
if ((!ONLY || ONLY === 'seg1') && SHOP_PASS)
  await seg('seg1-storefront', async (page, cur, beat) => {
    await page.goto(SHOP, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/password')) {
      await cur.click(page.locator('input[name="password"]'));
      await humanType(page, page.locator('input[name="password"]'), SHOP_PASS);
      await cur.click(page.locator('button[type="submit"], input[type="submit"]'));
      await page.waitForLoadState('domcontentloaded');
    }
    beat('open', 'Customer support is the last workflow\nstill priced per human hour.', 'bl');
    await page.waitForSelector('#janis-bubble', { timeout: 30000 });
    await page.waitForTimeout(2500);           // browse beat — let the store read
    await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'smooth' }));
    await page.waitForTimeout(2200);
    await cur.click(page.locator('#janis-bubble'));
    await page.waitForSelector('#janis-input', { timeout: 10000 });
    // expanded panel — the chat reads better at 680px than 340px
    const expand = page.locator('#janis-expand');
    if (await expand.count()) {
      await cur.click(expand);
      await page.waitForTimeout(800);
    }
    beat('chat-open', 'This is Janis running a real storefront —\nlive catalog, live pricing, in the chat bubble.', 'bl');
    await page.waitForTimeout(2500);

    await say(page, cur, 'Show me the snowboards you have for sale');
    // The agent may answer a browse ask with the collections picker ("What
    // would you like to browse?") instead of the product carousel. NB: the
    // picker TAP is a dead loop in the widget today (posts the name, agent
    // re-asks) — so don't tap it on camera. Give the cards a short window,
    // then a sharper follow-up ask that reliably pulls the carousel.
    if (!(await page.locator('.janis-wcards').count())) {
      await page.waitForSelector('.janis-wcards', { timeout: 15000 }).catch(() => {});
    }
    if (!(await page.locator('.janis-wcards').count())) {
      await say(page, cur, 'just show me all the boards you carry');
      await page.waitForSelector('.janis-wcards', { timeout: 90000 }).catch(() => {});
    }
    await scrollEnd(page);
    beat('cards', 'Not an FAQ — a revenue surface.\nReal products, real prices, in-chat.', 'bl');
    await page.waitForTimeout(2500);

    await say(page, cur, "what size board should I get? I'm 5'10\", 170lb");
    await page.waitForTimeout(1500);

    await say(page, cur, 'I want to buy the first board you showed me');
    if (!(await page.locator('#janis-msgs a[href*="checkout"], #janis-msgs a[href*="cart"]').count())) {
      await say(page, cur, 'my email is mike@example.com');
    }
    beat('checkout', 'The loop closes in-chat —\na checkout link, not a ticket.', 'bl');
    await page.waitForTimeout(2000);

    await say(page, cur, 'Actually I need to return an order I already received');
    beat('return', 'Until it needs judgment.\nThen it stops — by design.', 'bl');
    await page.waitForTimeout(6000);
    await caption(page, '');
  });
else if (!ONLY || ONLY === 'seg1')
  console.log('seg1 skipped — SHOP_PASS unset');

// ==== seg2: console inbox — the human side =============================
if (!ONLY || ONLY === 'seg2')
  await seg('seg2-inbox', async (page, cur, beat) => {
    await page.goto(`${APP}/conversations`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a.conv-row', { timeout: 20000 });
    await tidy(page);
    await page.waitForTimeout(2500);
    await cur.click(page.locator('a.conv-row').first());
    beat('thread', 'Same conversation, other side —\nfull context, instant human takeover.', 'up');
    // composer only exists in human state — on an agent-owned conv the
    // action row is the signal the page is ready, not a textarea
    await page.waitForSelector('button:has-text("Take over"), textarea', { timeout: 20000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const sc = document.querySelector('.msgs, .conv-msgs, [class*="scroll"]');
      (sc ?? document.scrollingElement)?.scrollTo?.(0, 999999);
    });
    await page.waitForTimeout(2000);

    // the differentiator beat: AI → human, same thread
    await cur.click(page.locator('button:has-text("Take over")'));
    beat('takeover', 'Every rescue is captured — not just answered.', 'up');
    await page.waitForSelector('.composer-inner textarea, textarea', { timeout: 20000 });
    await page.waitForTimeout(1800);
    const ta = page.locator('.composer-inner textarea, textarea').last();
    await cur.click(ta);
    await humanType(page, ta,
      "So sorry about the cracked board — I'll get a prepaid return label " +
      "over to you right now and a replacement out this week.");
    await page.waitForTimeout(800);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);

    // internal note — the rail a teammate sees
    const note = page.locator('button:has-text("Internal note")');
    if (await note.count()) {
      await cur.click(note);
      await page.waitForTimeout(1200);
      const ta2 = page.locator('.composer-inner textarea, textarea').last();
      await cur.click(ta2);
      await humanType(page, ta2, 'Replacement label sent — watch for the return scan.');
      await page.waitForTimeout(800);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
    }
  }, TOKEN);

// ==== seg3: rescue → learn =============================================
if (!ONLY || ONLY === 'seg3')
  await seg('seg3-learn', async (page, cur, beat) => {
    await page.goto(`${APP}/agents/${AGENT}/tests`, { waitUntil: 'domcontentloaded' });
    await tidy(page);
    await page.waitForTimeout(3500);
    // rescue-suggestion card → one click turns the save into a regression test
    const card = page.locator('details.card:has-text("rescued conversation")');
    if (await card.count()) {
      await page.waitForTimeout(1500);
      await cur.click(card.locator('summary'));
      await page.waitForTimeout(1500);
      beat('rescues', 'The moat: rescued threads surface here —');
      const sug = page.locator('button:has-text("Save as tests")').first();
      await cur.click(sug);
      beat('saved', '…and one click turns a save into a regression test.\nThe product compounds with use.');
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
      await page.waitForTimeout(2500);
    } else {
      // fallback: knowledge gaps card tells the same "it learns" story
      await page.goto(`${APP}/agents/${AGENT}/knowledge?sub=gaps`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
    }
  }, TOKEN);

// ==== seg4: how you'd build it — surface montage =======================
if (!ONLY || ONLY === 'seg4')
  await seg('seg4-build', async (page, cur, beat) => {
    const stops = [
      ['knowledge', `${APP}/agents/${AGENT}/knowledge`],
      ['behavior', `${APP}/agents/${AGENT}/behavior`],
      ['actions', `${APP}/agents/${AGENT}/integrations`],
      ['test', `${APP}/agents/${AGENT}/tests`],
      ['channels', `${APP}/agents/${AGENT}/channels`],
    ];
    await page.goto(stops[0][1], { waitUntil: 'domcontentloaded' });
    await tidy(page);
    beat('montage', 'Knowledge, behavior, actions, tests, channels —\na platform, not a feature.');
    await page.waitForTimeout(3000);
    for (const [name] of stops.slice(1)) {
      // click the real nav item like an operator would
      const link = page.locator(`a[href="/agents/${AGENT}/${name === 'actions' ? 'integrations' : name === 'test' ? 'tests' : name}"]`).first();
      if (await link.count()) await cur.click(link);
      else await page.goto(`${APP}/agents/${AGENT}/${name}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3800);
    }
  }, TOKEN);

// ==== seg5: the distribution rail — investor beat ======================
// TOKEN2 = a session on Mike's main workspace — that's where the migrated
// janistest3 install lives. The migrated-agents panel is the "17k legacy
// installs, one-click migration" shot without running a real migration.
if (!ONLY || ONLY === 'seg5')
  await seg('seg5-migration', async (page, cur, beat) => {
    await page.goto(`${APP}/settings?section=escalation`, { waitUntil: 'domcontentloaded' });
    await tidy(page);
    await page.waitForSelector('text=janistest3', { timeout: 20000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find((e) => e.textContent?.trim() === 'janistest3');
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    await page.waitForTimeout(2500);
    beat('migrated', '17,000 legacy installs migrate in one click —\ndistribution is a rail, not an ad spend.');
    await page.waitForTimeout(6500);
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await page.waitForTimeout(2500);
    await page.goto('https://www.janis.ai', { waitUntil: 'domcontentloaded' });
    beat('landing', 'AI when AI is best. Humans when humans are needed.\nJanis — janis.ai');
    await page.waitForTimeout(4000);
  }, process.env.SNOW_TOKEN2 ?? TOKEN);

await browser.close();
writeFileSync(join(VID, 'beats.json'), JSON.stringify(BEATS, null, 1));
console.log('segments + beats.json in', VID);
