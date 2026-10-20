import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const LISTING = '/Users/mnatha/Documents/shopify-listing';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const log = (...a) => console.log('[f5]', ...a);

// mark the three fields by their section label text
await page.evaluate(() => {
  const map = { 'Real-time messaging': 'f1', 'Automated responses': 'f2', 'Customization': 'f3' };
  for (const [label, id] of Object.entries(map)) {
    const lab = [...document.querySelectorAll('label, p, span, div')].find(e => e.children.length === 0 && e.textContent.trim() === label);
    if (!lab) continue;
    let card = lab;
    for (let i = 0; i < 8 && card; i++) { card = card.parentElement; if (card.querySelector('input[type="text"]')) break; }
    card?.setAttribute('data-tagfield', id);
  }
});

async function addTag(fieldId, tag) {
  const inp = page.locator(`[data-tagfield="${fieldId}"] input[type="text"], [data-tagfield="${fieldId}"] input:not([type])`).first();
  await inp.scrollIntoViewIfNeeded();
  await inp.click();
  await page.waitForTimeout(500);
  await inp.fill(tag.slice(0, 6));
  await page.waitForTimeout(1200);
  const box = await page.evaluate(({ tag }) => {
    const l = [...document.querySelectorAll('label')].find(l =>
      l.offsetParent !== null && l.querySelector('input[type="checkbox"]') && l.textContent.trim() === tag);
    if (!l) return null;
    const r = l.getBoundingClientRect();
    return { x: r.x + 14, y: r.y + r.height / 2, checked: l.querySelector('input').checked };
  }, { tag });
  if (!box) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); return 'miss'; }
  if (!box.checked) await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(500);
  return box.checked ? 'already' : 'picked';
}

const tagSets = [
  ['f1', ['AI chatbots', 'Live chat', 'Email chat', 'Social media']],
  ['f2', ['Order updates', 'Product recommendations', 'Quick replies']],
  ['f3', ['Chat window', 'Welcome messages', 'Color and font', 'Agent avatar']],
];
for (const [f, tags] of tagSets) for (const t of tags) log(f, t, '→', await addTag(f, t));
await page.screenshot({ path: `${OUT}/40-tags.png` });

// ---- feature media → Image + upload ----
await page.evaluate(() => {
  const r = [...document.querySelectorAll('input[name="assetTypeSelection"]')][1];
  (r.closest('label') ?? r).click();
});
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Feature media');
  let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
  c.querySelector('input[type="file"]')?.setAttribute('data-fm', '1');
});
await page.locator('input[data-fm="1"]').setInputFiles(`${LISTING}/01-inbox.png`);
await page.waitForTimeout(6000);
log('feature image uploaded');

// ---- screenshots ----
const shots = [
  ['01-inbox.png', 'Unified inbox: web chat, Messenger, Instagram, WhatsApp'],
  ['02-checkout-convo.png', 'Agent builds a checkout, sends the payment link'],
  ['03-return-convo.png', 'Guided returns with email verification'],
  ['04-sizing-convo.png', 'Product recommendations from your live catalog'],
  ['05-agent.png', 'Agent overview: resolution rate, gaps, channels'],
  ['06-channels.png', 'One agent across web chat and messaging channels'],
];
const dsFiles = () => page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Desktop screenshots');
  let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
  return c.querySelectorAll('input[type="file"]').length;
});
for (let i = 0; i < shots.length; i++) {
  while ((await dsFiles()) <= i) {
    await page.evaluate(() => {
      const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Desktop screenshots');
      let c = h; for (let k = 0; k < 10 && c; k++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
      [...c.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add')?.click();
    });
    await page.waitForTimeout(1500);
  }
  await page.evaluate((i) => {
    const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Desktop screenshots');
    let c = h; for (let k = 0; k < 10 && c; k++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
    c.querySelectorAll('input[type="file"]')[i].setAttribute('data-ds', i);
  }, i);
  await page.locator(`input[data-ds="${i}"]`).setInputFiles(`${LISTING}/${shots[i][0]}`);
  await page.waitForTimeout(6000);
  const alt = page.locator(`input[name="desktopScreenshots.${i}.imageAltText"]`);
  if (await alt.count()) await alt.fill(shots[i][1]);
  log('shot', i + 1, shots[i][0]);
}
await page.screenshot({ path: `${OUT}/42-shots.png` });

// ---- subtitle + search terms + sales channel ----
await page.locator('input[name="subtitle"]').fill('AI agent that answers shoppers and looks up orders');
for (const term of ['AI chatbot', 'customer support', 'live chat', 'order lookup', 'product recommendations']) {
  await page.evaluate((term) => {
    const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'App store search terms');
    let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input[type="text"]')) break; }
    const inp = [...c.querySelectorAll('input[type="text"]')].find(i => !i.name && i.offsetParent !== null);
    if (!inp) return;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, term);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    [...c.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add' && !b.disabled)?.click();
  }, term);
  await page.waitForTimeout(700);
  log('term:', term);
}
await page.evaluate(() => {
  const r = document.querySelector('input[name="salesChannelRequiredSelection"]');
  (r.closest('label') ?? r).click();
});
await page.waitForTimeout(700);
await page.evaluate(() => {
  const r = document.querySelector('input[name="salesChannelRequiredSelection"]');
  let card = r; for (let i = 0; i < 8 && card; i++) card = card.parentElement;
  const cb = [...card.querySelectorAll('label')].find(l => l.textContent.includes('Online Store'))?.querySelector('input[type="checkbox"]');
  if (cb && !cb.checked) cb.closest('label').click();
});
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/43-pre-save.png` });
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
await page.waitForTimeout(8000);
log('after save:', await page.evaluate(() => (document.body.innerText.match(/(\d+) issues?/) || [])[0] ?? 'no-issue-label'));
await page.screenshot({ path: `${OUT}/44-post-save.png` });
await ctx.close();
