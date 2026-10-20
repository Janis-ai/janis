import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const LISTING = '/Users/mnatha/Documents/shopify-listing';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const log = (...a) => console.log('[f4]', ...a);

// ---- tag field: click input, type search, click matching checkbox option ----
async function addTag(placeholder, tag) {
  const inp = page.locator(`input[placeholder="${placeholder}"]`);
  await inp.scrollIntoViewIfNeeded();
  await inp.click();
  await page.waitForTimeout(600);
  // clear + type search
  await inp.fill('');
  await inp.pressSequentially(tag.slice(0, 5), { delay: 40 });
  await page.waitForTimeout(1200);
  const box = await page.evaluate(({ tag }) => {
    const labels = [...document.querySelectorAll('label')].filter(l =>
      l.offsetParent !== null && l.querySelector('input[type="checkbox"]') &&
      l.textContent.trim() === tag);
    const l = labels[0];
    if (!l) return null;
    const r = l.getBoundingClientRect();
    return { x: r.x + 14, y: r.y + r.height / 2, checked: l.querySelector('input').checked };
  }, { tag });
  if (!box) { log('  MISS:', tag); await page.keyboard.press('Escape'); return false; }
  if (!box.checked) await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(500);
  return true;
}

// 1) category details
const tagSets = [
  ['Example: AI chatbots, Live chat, SMS', ['AI chatbots', 'Live chat', 'Email chat', 'Social media']],
  ['Example: Cart recovery, COD verification, Discounts', ['Order updates', 'Product recommendations', 'Quick replies']],
  ['Example: Color and font, Emojis and stickers, Chat window', ['Chat window', 'Welcome messages', 'Color and font', 'Agent avatar']],
];
for (const [ph, tags] of tagSets) {
  for (const t of tags) log(' tag', t, await addTag(ph, t));
}
await page.screenshot({ path: `${OUT}/40-tags.png` });

// 2) feature media → Image
await page.evaluate(() => {
  const r = [...document.querySelectorAll('input[name="assetTypeSelection"]')][1];
  (r.closest('label') ?? r).click();
});
await page.waitForTimeout(1200);
const fmSet = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Feature media');
  let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
  const f = [...c.querySelectorAll('input[type="file"]')];
  f[0]?.setAttribute('data-fm', '1');
  return f.length;
});
log('fm file inputs:', fmSet);
await page.locator('input[data-fm="1"]').setInputFiles(`${LISTING}/01-inbox.png`);
await page.waitForTimeout(6000);
log('feature image uploaded');
await page.screenshot({ path: `${OUT}/41-feature.png` });

// 3) screenshots — upload to existing 3 slots, then Add for 3 more
const shots = [
  ['01-inbox.png', 'Unified inbox: web chat, Messenger, Instagram, WhatsApp'],
  ['02-checkout-convo.png', 'Agent builds a checkout, sends the payment link'],
  ['03-return-convo.png', 'Guided returns with email verification'],
  ['04-sizing-convo.png', 'Product recommendations from your live catalog'],
  ['05-agent.png', 'Agent overview: resolution rate, gaps, channels'],
  ['06-channels.png', 'One agent across web chat and messaging channels'],
];
const dsCard = '(() => { const h=[...document.querySelectorAll("h2,h3,p,strong")].find(x=>x.textContent.trim()==="Desktop screenshots"); let c=h; for(let i=0;i<10&&c;i++){c=c.parentElement; if(c.querySelector(\'input[type="file"]\'))break;} return c; })()';
for (let i = 0; i < shots.length; i++) {
  let n = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Desktop screenshots');
    let c = h; for (let k = 0; k < 10 && c; k++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
    return c.querySelectorAll('input[type="file"]').length;
  });
  while (n <= i) {
    await page.evaluate(() => {
      const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Desktop screenshots');
      let c = h; for (let k = 0; k < 10 && c; k++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
      [...c.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add')?.click();
    });
    await page.waitForTimeout(1500);
    n = await page.evaluate(() => {
      const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Desktop screenshots');
      let c = h; for (let k = 0; k < 10 && c; k++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
      return c.querySelectorAll('input[type="file"]').length;
    });
  }
  await page.evaluate((i) => {
    const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'Desktop screenshots');
    let c = h; for (let k = 0; k < 10 && c; k++) { c = c.parentElement; if (c.querySelector('input[type="file"]')) break; }
    c.querySelectorAll('input[type="file"]')[i].setAttribute('data-ds', i);
  }, i);
  await page.locator(`input[data-ds="${i}"]`).setInputFiles(`${LISTING}/${shots[i][0]}`);
  await page.waitForTimeout(6000);
  await page.locator(`input[name="desktopScreenshots.${i}.imageAltText"]`).fill(shots[i][1]);
  log('shot', i + 1, 'uploaded');
}
await page.screenshot({ path: `${OUT}/42-shots.png` });

// 4) subtitle (no "Shopify")
await page.locator('input[name="subtitle"]').fill('AI agent that answers shoppers and looks up orders');

// 5) search terms
for (const term of ['AI chatbot', 'customer support', 'live chat', 'order lookup', 'product recommendations']) {
  const done = await page.evaluate((term) => {
    const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'App store search terms');
    let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input[type="text"]')) break; }
    const inp = [...c.querySelectorAll('input[type="text"]')].find(i => !i.name && i.offsetParent !== null);
    if (!inp) return 'noinput';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, term);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.focus();
    return 'ok';
  }, term);
  await page.waitForTimeout(300);
  // click the adjacent "Add" button
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('h2,h3,p,strong')].find(x => x.textContent.trim() === 'App store search terms');
    let c = h; for (let i = 0; i < 10 && c; i++) { c = c.parentElement; if (c.querySelector('input[type="text"]')) break; }
    [...c.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add' && !b.disabled)?.click();
  });
  await page.waitForTimeout(600);
  log('term:', term, done);
}

// 6) sales channel — requires Online Store
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
log('sales:', await page.evaluate(() => ({
  req: document.querySelector('input[name="salesChannelRequiredSelection"]')?.checked,
})).then(j => JSON.stringify(j)));

await page.screenshot({ path: `${OUT}/43-pre-save.png` });
// ---- save ----
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
await page.waitForTimeout(8000);
log('after save:', await page.evaluate(() => (document.body.innerText.match(/(\d+) issues?/) || [])[0] ?? 'no-issue-label'));
await page.screenshot({ path: `${OUT}/44-post-save.png` });
await ctx.close();
