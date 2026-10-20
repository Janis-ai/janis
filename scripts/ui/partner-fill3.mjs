import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const LISTING = '/Users/mnatha/Documents/shopify-listing';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const log = (...a) => console.log('[fill3]', ...a);

// ---- helper: card containing an element ----
// find tag field card by its placeholder
async function tagField(placeholder, wanted) {
  const inp = page.locator(`input[placeholder="${placeholder}"]`);
  await inp.scrollIntoViewIfNeeded();
  await inp.click();
  await page.waitForTimeout(1200);
  const res = await page.evaluate(({ ph, wanted }) => {
    const input = [...document.querySelectorAll('input')].find(i => i.placeholder === ph);
    let card = input;
    for (let i = 0; i < 10 && card; i++) { card = card.parentElement; if (card.querySelectorAll('label input[type="checkbox"]').length) break; }
    const labels = [...card.querySelectorAll('label')].filter(l => l.offsetParent !== null && l.querySelector('input[type="checkbox"]'));
    const all = labels.map(l => l.textContent.trim());
    const hits = [];
    for (const w of wanted) {
      const l = labels.find(l => l.textContent.trim() === w && !l.querySelector('input').checked);
      if (l) { const r = l.getBoundingClientRect(); hits.push({ w, x: r.x + 12, y: r.y + r.height / 2 }); }
    }
    return { all: all.filter(t => t.length < 60), hits };
  }, { ph: placeholder, wanted });
  log(placeholder.slice(9, 38), 'opts:', JSON.stringify(res.all.slice(0, 12)));
  for (const h of res.hits) { await page.mouse.click(h.x, h.y); await page.waitForTimeout(400); log('  picked:', h.w); }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  return res.hits.length;
}

// 1) category details — all three fields in one pass
await tagField('Example: AI chatbots, Live chat, SMS', ['Live chat', 'Chat', 'Chatbot']);
await tagField('Example: Cart recovery, COD verification, Discounts', ['Chatbot', 'AI chatbot', 'Auto-responder', 'Automated responses', 'Canned responses', 'AI-generated responses', 'FAQ', 'Answer bot']);
await tagField('Example: Color and font, Emojis and stickers, Chat window', ['Chat window', 'Color and font', 'Agent avatar']);

// 2) feature media — switch to Image
const imgRadio = page.locator('input[name="assetTypeSelection"]').nth(1);
await imgRadio.scrollIntoViewIfNeeded();
await page.evaluate(() => {
  const r = [...document.querySelectorAll('input[name="assetTypeSelection"]')][1];
  (r.closest('label') ?? r).click();
});
await page.waitForTimeout(1200);
// feature image file input = first file input in Feature media card
const fmInput = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h3')].find(x => x.textContent.trim() === 'Feature media');
  let c = h; for (let i = 0; i < 8 && c; i++) c = c.parentElement;
  const f = [...c.querySelectorAll('input[type="file"]')];
  return f.length;
});
log('feature-media file inputs:', fmInput);
await page.evaluate(() => {
  const h = [...document.querySelectorAll('h3')].find(x => x.textContent.trim() === 'Feature media');
  let c = h; for (let i = 0; i < 8 && c; i++) c = c.parentElement;
  window.__fmCard = c;
});
const fmFile = page.locator('h3:has-text("Feature media")').locator('xpath=ancestor::*[self::div or self::section][.//input[@type="file"]][1]').locator('input[type="file"]').first();
await fmFile.setInputFiles(`${LISTING}/01-inbox.png`);
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/36-feature.png` });
log('feature image set');

// 3) desktop screenshots — 3 slots exist; upload + alt text, add 3 more
const shots = [
  ['01-inbox.png', 'Every customer conversation, one inbox — web chat, Messenger, Instagram, WhatsApp'],
  ['02-checkout-convo.png', 'Janis builds a checkout and sends the payment link right in the conversation'],
  ['03-return-convo.png', 'Guided returns — verifies the customer, pulls the order, files the request'],
  ['04-sizing-convo.png', 'Product recommendations from your live catalog, with variants and add-to-cart'],
  ['05-agent.png', 'Your agent at a glance — resolution rate, knowledge gaps, channels'],
  ['06-channels.png', 'Deploy the same agent across web chat and every messaging channel'],
];
for (let i = 0; i < shots.length; i++) {
  // ensure slot i exists: click an "Add" button in Desktop screenshots area while slots < i+1
  let count = await page.locator('input[name^="desktopScreenshots"][name$="imageAltText"]').count();
  while (count <= i) {
    await page.evaluate(() => {
      const h = [...document.querySelectorAll('h3')].find(x => x.textContent.trim() === 'Desktop screenshots');
      let c = h; for (let i = 0; i < 8 && c; i++) c = c.parentElement;
      [...c.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add')?.click();
    });
    await page.waitForTimeout(1200);
    count = await page.locator('input[name^="desktopScreenshots"][name$="imageAltText"]').count();
  }
  // file input paired with slot i — the file inputs in the desktop card, ordered
  const fi = await page.evaluate((i) => {
    const h = [...document.querySelectorAll('h3')].find(x => x.textContent.trim() === 'Desktop screenshots');
    let c = h; for (let k = 0; k < 8 && c; k++) c = c.parentElement;
    const files = [...c.querySelectorAll('input[type="file"]')];
    files.forEach((f, idx) => f.setAttribute('data-shot-idx', idx));
    return files.length;
  }, i);
  await page.locator(`input[data-shot-idx="${i}"]`).setInputFiles(`${LISTING}/${shots[i][0]}`);
  await page.waitForTimeout(6000);
  await page.locator(`input[name="desktopScreenshots.${i}.imageAltText"]`).fill(shots[i][1]);
  log('shot', i, 'uploaded:', shots[i][0], '| slots:', fi);
}
await page.screenshot({ path: `${OUT}/37-shots.png` });

// 4) subtitle — no "Shopify"
await page.locator('input[name="subtitle"]').fill('AI agent that answers shoppers and looks up orders');

// 5) search terms — find the unnamed text input inside the search-terms card, type + Enter or Add
const stInfo = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h3, label')].find(x => x.textContent.trim() === 'App store search terms');
  let c = h; for (let i = 0; i < 8 && c; i++) c = c.parentElement;
  const inp = [...c.querySelectorAll('input[type="text"]')];
  inp.forEach((el, idx) => el.setAttribute('data-sterm', idx));
  return inp.length;
});
log('search-term inputs:', stInfo);
for (const term of ['AI chatbot', 'customer support', 'live chat', 'order lookup', 'product recommendations']) {
  const inp = page.locator('input[data-sterm="0"]');
  await inp.fill(term);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
}

// 6) sales channel — requires Online Store
await page.evaluate(() => {
  const r = document.querySelector('input[name="salesChannelRequiredSelection"]');
  (r.closest('label') ?? r).click();
});
await page.waitForTimeout(800);
await page.evaluate(() => {
  const r = document.querySelector('input[name="salesChannelRequiredSelection"]');
  let card = r; for (let i = 0; i < 8 && card; i++) card = card.parentElement;
  const cb = [...card.querySelectorAll('label')].find(l => l.textContent.includes('Online Store'))?.querySelector('input[type="checkbox"]');
  if (cb && !cb.checked) (cb.closest('label')).click();
});
await page.waitForTimeout(800);
const salesState = await page.evaluate(() => ({
  req: document.querySelector('input[name="salesChannelRequiredSelection"]')?.checked,
  boxes: [...document.querySelectorAll('input[type="checkbox"]')].filter(c => c.checked).map(c => c.closest('label')?.textContent.trim().slice(0, 50)),
}));
log('sales state:', JSON.stringify(salesState));

await page.screenshot({ path: `${OUT}/38-pre-save.png` });
// ---- save ----
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
await page.waitForTimeout(8000);
const final = await page.evaluate(() => (document.body.innerText.match(/(\d+) issues?/) || [])[0] ?? 'no-issue-label');
log('after save:', final, '| url:', page.url());
await page.screenshot({ path: `${OUT}/39-post-save.png` });
await ctx.close();
