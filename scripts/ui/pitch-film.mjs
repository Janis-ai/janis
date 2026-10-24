// Investor-pitch film — Acts 0–5 of docs/marketing/investor-pitch-script.md.
// Same rig as demo-film.mjs (animated cursor, human typing, caption overlay).
// Records CLEAN footage once — beats.json carries VO text+timings; the
// read-along copy burns them via .ass so both cuts share the same takes.
//   SNOW_TOKEN=<snow ws> SNOW_TOKEN2=<main ws> SHOP_PASS=newtsu node scripts/ui/pitch-film.mjs
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHOP = process.env.SHOP ?? 'https://snowboardsareus.myshopify.com';
const APP = process.env.APP ?? 'https://app.janis.ai';
const AGENT = process.env.AGENT_ID ?? '51a81b16-f6a1-4dfa-ac83-15e116690269';
const CONV = process.env.CONV_ID ?? '56549a95-2098-40a2-91ee-1b341aafb310';
const SHOP_PASS = process.env.SHOP_PASS ?? '';
const TOKEN = process.env.SNOW_TOKEN;
const VID = process.env.VID_DIR ?? '/tmp/janis-pitch';
mkdirSync(VID, { recursive: true });
const browser = await chromium.launch({ headless: true });

const CURSOR_INIT = () => {
  try { localStorage.setItem('janis_theme', 'light'); } catch {}
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
      #__filmcur.__down .__d{scale:.72}`;
    document.documentElement.appendChild(s);
    const c = document.createElement('div');
    c.id = '__filmcur';
    c.innerHTML = '<div class="__d"></div>';
    document.documentElement.appendChild(c);
  };
  if (document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount);
};

class Cursor {
  constructor(page) { this.page = page; this.x = 64; this.y = 64; }
  async _set(x, y, ms) {
    await this.page.evaluate(([x, y, ms]) => {
      const c = document.getElementById('__filmcur');
      if (!c) return;
      c.style.transitionDuration = ms + 'ms';
      c.style.transform = `translate(${x - 9}px,${y - 9}px)`;
    }, [x, y, ms]);
    this.x = x; this.y = y;
    if (ms) await this.page.waitForTimeout(ms + 40);
  }
  async to(loc, ms) {
    const box = await loc.boundingBox();
    if (!box) return;
    const tx = box.x + box.width / 2 + (Math.random() * 8 - 4);
    const ty = box.y + box.height / 2 + (Math.random() * 6 - 3);
    const dur = ms ?? Math.min(650, Math.max(240, Math.hypot(tx - this.x, ty - this.y) * 0.55));
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

async function humanType(page, loc, text) {
  await loc.click();
  for (const ch of text) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(38 + Math.random() * 70);
  }
}

const BEATS = {};
const GAPS = {};
let segT0 = 0;
const seg = async (name, fn, cookie) => {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    recordVideo: { dir: VID, size: { width: 1600, height: 1000 } },
  });
  await ctx.addInitScript(CURSOR_INIT);
  if (cookie) {
    await ctx.addCookies([{
      name: 'janis_session', value: cookie, domain: 'app.janis.ai', path: '/',
      httpOnly: true, secure: true, sameSite: 'Lax',
    }]);
  }
  const page = await ctx.newPage();
  const cur = new Cursor(page);
  const t0 = Date.now();
  segT0 = t0;
  const marks = (BEATS[name] = []);
  const gaps = (GAPS[name] = []);
  page.__gaps = gaps;
  const beat = (n, cap) => marks.push({ n, t: Date.now() - t0, cap });
  try { await fn(page, cur, beat); }
  catch (e) { console.log(`${name} ERR:`, e.message); }
  finally {
    await ctx.close();
    const files = readdirSync(VID)
      .filter((f) => f.endsWith('.webm') && !f.startsWith('act'))
      .map((f) => ({ f, t: statSync(join(VID, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (files[0]) renameSync(join(VID, files[0].f), join(VID, `${name}.webm`));
    console.log('seg', name);
  }
};

const agentMsgs = (page) => page.locator('#janis-msgs .janis-msg.out, #janis-msgs .janis-msg.human').count();
const scrollEnd = (page) => page.evaluate(() => {
  const el = document.querySelector('#janis-msgs');
  if (el) el.scrollTop = el.scrollHeight;
});
const settle = async (page) => {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const cur = await page.evaluate(() => document.querySelector('#janis-msgs')?.innerHTML ?? '');
    const typing = await page.evaluate(() => !!document.querySelector('#janis-msgs [class*="typing"], #janis-msgs .janis-typing'));
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
  const sentAt = Date.now() - segT0;
  await page.waitForFunction(
    (b) => document.querySelectorAll('#janis-msgs .janis-msg.out, #janis-msgs .janis-msg.human').length > b,
    before, { timeout: 150000 });
  const repliedAt = Date.now() - segT0;
  page.__gaps.push({ send: sentAt, reply: repliedAt });
  await settle(page);
  await page.waitForTimeout(1500);
};
const tidy = async (page) => { await page.click('.push-banner-dismiss').catch(() => {}); };
const ONLY = process.env.ONLY;

// ==== Act 0 — the queue ================================================
if (!ONLY || ONLY === 'act0')
  await seg('act0-queue', async (page, cur, beat) => {
    beat('open', 'This is Janis.');
    await page.goto(`${APP}/conversations`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a.conv-row', { timeout: 20000 });
    await tidy(page);
    beat('queue', "This is every customer conversation a business has — web chat,\nWhatsApp, email, SMS, voice, Slack — one queue. Most lines are\nthe AI working; the flagged ones are asking for a human.");
    await page.waitForTimeout(12000);
  }, TOKEN);

// ==== Act 1 — the storefront, live =====================================
if ((!ONLY || ONLY === 'act1') && SHOP_PASS)
  await seg('act1-storefront', async (page, cur, beat) => {
    await page.goto(SHOP, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/password')) {
      await cur.click(page.locator('input[name="password"]'));
      await humanType(page, page.locator('input[name="password"]'), SHOP_PASS);
      await cur.click(page.locator('button[type="submit"], input[type="submit"]'));
      await page.waitForLoadState('domcontentloaded');
    }
    beat('cut_before');
    beat('store', "This is Janis inside a real Shopify storefront —\nlive catalog, live pricing, inside the chat bubble.");
    await page.waitForSelector('#janis-bubble', { timeout: 30000 });
    // the teaser blurb invites the click — let it live on camera
    await page.waitForSelector('#janis-teaser', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
    beat('teaser', 'The widget introduces itself — proactive, branded,\ninviting the shopper in before they even click.');
    await page.waitForTimeout(2500);
    await cur.click(page.locator('#janis-teaser, #janis-bubble').first());
    await page.waitForSelector('#janis-input', { timeout: 10000 });
    const expand = page.locator('#janis-expand');
    if (await expand.count()) { await cur.click(expand); await page.waitForTimeout(800); }
    // greeting pop — wait for the agent's hello before we ask anything
    const g0 = Date.now() - segT0;
    await page.waitForSelector('#janis-msgs .janis-msg', { timeout: 30000 }).catch(() => {});
    page.__gaps.push({ send: g0, reply: Date.now() - segT0 });
    beat('greet', 'The widget wakes up and greets the shopper —\nbranded, instant, ready to help.');
    await page.waitForTimeout(1200);

    await say(page, cur, 'Show me the snowboards you have for sale');
    if (!(await page.locator('.janis-wcards').count()))
      await page.waitForSelector('.janis-wcards', { timeout: 20000 }).catch(() => {});
    if (!(await page.locator('.janis-wcards').count()))
      await say(page, cur, 'just show me all the boards you carry');
    await scrollEnd(page);
    beat('cards', "'On sale' isn't a canned answer — that's a live query —\nreal products, real prices, real stock, as tappable cards.");
    await page.waitForTimeout(2500);

    const seeOpts = page.locator('#janis-msgs button:has-text("See options")').first();
    if (await seeOpts.count()) {
      await cur.click(seeOpts);
      await page.waitForTimeout(1200);
      const add = page.locator('.janis-opts-wrap button:has-text("Add"), .janis-opts-wrap button:has-text("cart")').first();
      if (await add.count()) { await cur.click(add); }
      await page.waitForTimeout(2000);
    }
    await say(page, cur, 'checkout');
    beat('cart', 'Sees options, picks a size, adds to cart —\nand the checkout link closes the loop, in-chat.');
    await page.waitForTimeout(2500);

    await say(page, cur, 'Actually — can I talk to a person about a return?');
    beat('handoff', "A request AI shouldn't guess on — it doesn't fake it.\nIt raises a human alert instead. Watch what happens next.");
    await page.waitForTimeout(7000);
  });
else if (!ONLY || ONLY === 'act1') console.log('act1 skipped — SHOP_PASS unset');

// ==== Act 2 — one thread, console side =================================
if (!ONLY || ONLY === 'act2')
  await seg('act2-thread', async (page, cur, beat) => {
    await page.goto(`${APP}/agents/${AGENT}/inbox`, { waitUntil: 'domcontentloaded' });
    await tidy(page);
    await page.waitForTimeout(2500);
    const firstRow = page.locator('a[href*="/inbox/"]').first();
    if (await firstRow.count()) await cur.click(firstRow);
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      const sc = document.querySelector('.msgs, .conv-msgs, [class*="scroll"]');
      (sc ?? document.scrollingElement)?.scrollTo?.(0, 0);
    });
    beat('alert', 'Inside Janis, that request is an open alert —\nrouted, prioritized, waiting on a human. The same alert\nlands in the team\'s Slack the moment it fires.');
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const sc = document.querySelector('.msgs, .conv-msgs, [class*="scroll"]');
      (sc ?? document.scrollingElement)?.scrollTo?.({ top: 999999, behavior: 'smooth' });
    });
    await page.waitForTimeout(3500);
    const take = page.locator('button:has-text("Take over")');
    if (await take.count()) {
      await cur.click(take.first());
      beat('takeover', 'One click and a human steps in — same thread, full\ncontext — then hands it back. Nobody repeats themselves.');
      await page.waitForSelector('.composer-inner textarea, textarea', { timeout: 20000 });
      await page.waitForTimeout(1500);
      const ta = page.locator('.composer-inner textarea, textarea').last();
      await cur.click(ta);
      await humanType(page, ta, "So sorry about the cracked board — I'll get a prepaid return label to you right now.");
      await page.waitForTimeout(600);
      await page.keyboard.press('Enter');
      beat('reply', 'The operator replies — one thread, full context,\nno re-explaining, no lost history.');
      await page.waitForTimeout(2500);
    }
    // back to the storefront — the human's reply lands in the visitor's bubble
    await page.goto(SHOP, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/password')) {
      await cur.click(page.locator('input[name="password"]'));
      await humanType(page, page.locator('input[name="password"]'), SHOP_PASS);
      await cur.click(page.locator('button[type="submit"], input[type="submit"]'));
      await page.waitForLoadState('domcontentloaded');
    }
    await page.waitForSelector('#janis-bubble', { timeout: 30000 }).catch(() => {});
    beat('backtostore', 'And back on the store — the human\'s answer\nlands in the same bubble. Seamless, both sides.');
    await page.waitForTimeout(2500);
    await cur.click(page.locator('#janis-bubble')).catch(() => {});
    await page.waitForSelector('#janis-msgs .janis-msg', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3500);
  }, TOKEN);

// ==== Act 3 — rescue → regression test =================================
if (!ONLY || ONLY === 'act3')
  await seg('act3-learn', async (page, cur, beat) => {
    await page.goto(`${APP}/agents/${AGENT}/tests`, { waitUntil: 'domcontentloaded' });
    await tidy(page);
    await page.waitForTimeout(3500);
    const card = page.locator('details.card:has-text("rescued conversation")');
    if (await card.count()) {
      await cur.click(card.locator('summary'));
      await page.waitForTimeout(1500);
      beat('rescue', 'Every rescue lands here — flagged, fix drafted,\none click makes it a regression test. The product\ngets better because it was used.');
      const sug = page.locator('button:has-text("Save as tests")').first();
      await cur.click(sug);
      await page.waitForTimeout(3500);
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
      await page.waitForTimeout(2500);
    } else {
      await page.goto(`${APP}/agents/${AGENT}/knowledge?sub=gaps`, { waitUntil: 'domcontentloaded' });
      beat('gaps', 'And every gap becomes a knowledge draft —\nthe product gets better because it was used.');
      await page.waitForTimeout(5000);
    }
  }, TOKEN);

// ==== Act 4 — platform sweep ===========================================
if (!ONLY || ONLY === 'act4')
  await seg('act4-sweep', async (page, cur, beat) => {
    const stops = [
      ['knowledge', `${APP}/agents/${AGENT}/knowledge`, 'It answers from what it knows —\ncatalog, docs, policies.'],
      ['behavior', `${APP}/agents/${AGENT}/behavior`, 'It acts how you tell it —\ntone, procedures, when to stop.'],
      ['integrations', `${APP}/agents/${AGENT}/integrations`, 'Tools it can run — orders, refunds, CRM —\nwith approval gates on anything that spends money.'],
      ['ask', `${APP}/conversations?rail=ask`, "And operators get a copilot\nthat knows the whole workspace."],
      ['campaigns', `${APP}/campaigns`, "It doesn't just answer —\nabandoned carts, win-backs, proactive outreach."],
      ['channels', `${APP}/agents/${AGENT}/channels`, 'One agent definition, deployed\neverywhere a customer already is.'],
    ];
    await page.goto(stops[0][1], { waitUntil: 'domcontentloaded' });
    await tidy(page);
    beat(stops[0][0], stops[0][2]);
    await page.waitForTimeout(7000);
    for (const [name, url, cap] of stops.slice(1)) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      beat(name, cap);
      if (name === 'ask') {
        const inp = page.locator('textarea, input[type="text"]').last();
        if (await inp.count()) {
          await cur.click(inp);
          await humanType(page, inp, 'which conversations need a human right now?');
          await page.waitForTimeout(400);
          await page.keyboard.press('Enter');
        }
      }
      await page.waitForTimeout(5000);
    }
  }, TOKEN);

// ==== Act 5 — distribution ==============================================
if (!ONLY || ONLY === 'act5')
  await seg('act5-distribution', async (page, cur, beat) => {
    await page.goto(`${APP}/settings?section=escalation`, { waitUntil: 'domcontentloaded' });
    await tidy(page);
    await page.waitForSelector('text=janistest', { timeout: 20000 });
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find((e) => e.textContent?.trim() === 'janistest3');
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    beat('rail', "And the part you can't buy: seventeen thousand businesses\nsigned up for the classic Janis. Migrating is one click —\nagents, channels, credentials come with them.\nDistribution is a rail, not an ad spend.");
    await page.waitForTimeout(9000);
    await page.goto('https://www.janis.ai', { waitUntil: 'domcontentloaded' });
    beat('close', 'AI when AI is best. Humans when humans are needed.\nOne seamless conversation — and a system that learns\nevery time it was wrong. That is Janis.');
    await page.waitForTimeout(5000);
  }, process.env.SNOW_TOKEN2 ?? TOKEN);

await browser.close();
writeFileSync(join(VID, 'beats.json'), JSON.stringify(BEATS, null, 1));
writeFileSync(join(VID, 'gaps.json'), JSON.stringify(GAPS, null, 1));
console.log('segments + beats.json in', VID);
