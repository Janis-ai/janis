// Drive the REAL Shopify storefront in the user's own Chrome window via
// AppleScript JS execution (Chrome → View → Developer → Allow JavaScript
// from Apple Events). The tab is resolved fresh by URL each call.
//   node scripts/ui/storefront-drive.mjs
import { execFileSync } from 'node:child_process';

const SHOP = process.env.SHOP_HOST ?? 'janis-store-sx5bpcd3.myshopify.com';

function tabRef() {
  const script = `tell application "Google Chrome"
  repeat with w from 1 to count windows
    repeat with t from 1 to count tabs of window w
      try
        if URL of tab t of window w contains "${SHOP}" and URL of tab t of window w does not contain "admin.shopify" then return (w & ":" & t) as text
      end try
    end repeat
  end repeat
  return "0:0"
end tell`;
  // The enumeration itself can hit "Invalid index" while Chrome shuffles
  // tabs mid-navigation — retry briefly before giving up.
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
    } catch (e) {
      lastErr = e;
      execFileSync('sleep', ['0.3']);
    }
  }
  throw lastErr;
}

/** Run JS in the storefront tab; returns the string result (eval last expr).
 *  Tabs can shift between resolving the index and executing — retry on
 *  the "Invalid index" class of AppleScript errors with a fresh resolve. */
function js(code) {
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = tabRef();
    if (ref === '0:0') throw new Error('no storefront tab open');
    const [w, t] = ref.split(':');
    try {
      const out = execFileSync('osascript', [
        '-e',
        `tell application "Google Chrome" to tell tab ${t} of window ${w} to execute javascript "eval(atob(\\"${b64}\\\"))"`,
      ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      return out.trim();
    } catch (e) {
      lastErr = e;
      const msg = String(e.stderr || e.message || e);
      if (!/Invalid index|Can't get tab|1719|1728/.test(msg)) throw e;
      execFileSync('sleep', ['0.4']);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predCode, timeout = 60_000, label = predCode.slice(0, 60)) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (js(`!!(${predCode})`) === 'true') return true;
    await sleep(700);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// .janis-msg.out.typing is the dots indicator — only real bubbles count.
const OUT_SEL = '.janis-msg.out:not(.typing)';
const outCount = () => Number(js(`document.querySelectorAll('${OUT_SEL}').length`));

async function send(text) {
  console.log(`\n→ typing: ${text}`);
  js(`(() => { const i = document.querySelector('#janis-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input',{bubbles:true})); return i.value; })()`);
  js(`document.querySelector('#janis-send').click()`);
  const before = await outCount();
  // wait for a REAL out bubble (not the typing dots), then settle
  await waitFor(`document.querySelectorAll('${OUT_SEL}').length > ${before}`, 75_000, 'agent reply');
  await waitFor(`(() => { const m=[...document.querySelectorAll('${OUT_SEL}')].pop(); return m && m.innerText.trim().length > 0; })()`, 30_000, 'reply text');
  await sleep(2500);
  const last = js(`(() => { const m = [...document.querySelectorAll('${OUT_SEL}')].pop(); return m ? m.innerText.slice(0,400) : ''; })()`);
  console.log(`  agent: ${last.replace(/\n+/g, ' | ').slice(0, 200)}`);
  return last;
}

const snap = (label) => {
  const s = js(`JSON.stringify((() => {
    const lastOut = [...document.querySelectorAll('${OUT_SEL}')].pop();
    const scope = lastOut || document;
    return {
      replyText: lastOut ? lastOut.innerText.replace(/\\n+/g,' | ').slice(0,220) : null,
      cards: [...scope.querySelectorAll('.janis-wcard')].map(c => ({
        t: (c.querySelector('.janis-wcard-t')||{}).textContent,
        p: (c.querySelector('.janis-wcard-p')||{}).textContent || null,
        opts: [...c.querySelectorAll('.janis-wcard-s')].map(o => o.textContent).join(' | ') || null,
        stock: (c.querySelector('.janis-wcard-stock')||{}).textContent || null,
        btns: [...c.querySelectorAll('.janis-wbtn')].map(b => b.textContent.slice(0,20)),
      })),
      addBtns: [...scope.querySelectorAll('.janis-wbtn')].filter(b => /add to cart/i.test(b.textContent)).length,
      more: (scope.querySelector('.janis-wmore')||{}).textContent || null,
      cartRows: scope.querySelectorAll('.janis-cart-row').length,
      cartBody: (scope.querySelector('.janis-cart-body')||{innerText:''}).innerText.slice(0,300),
      chips: [...document.querySelectorAll('.janis-qr')].map(b => b.textContent),
    };
  })())`);
  console.log(`\n[${label}]`, s);
  return JSON.parse(s);
};

// ---- go -----------------------------------------------------------------
console.log('tab:', tabRef());
if (process.env.FRESH === '1') {
  js(`(() => { Object.keys(localStorage).filter(k=>/janis/i.test(k)).forEach(k=>localStorage.removeItem(k)); location.reload(); return 'reset'; })()`);
  await sleep(5000);
  await waitFor(`!!document.querySelector('#janis-bubble')`, 30_000, 'widget reload');
}
js(`document.querySelector('#janis-bubble')?.click(); 'opened'`);
await sleep(1200);
await waitFor(`document.querySelector('#janis-input')`, 10_000, 'input');
console.log('panel open — starting battery (watch your window)\n');

// 1. browse — cards + Add to cart buttons (storefront!) + 10-of-13 tile
await send('show me your products');
const s1 = snap('after browse');
console.log(`  ✓ add-to-cart buttons: ${s1.addBtns}, tile: ${s1.more}`);

// 2. add-to-cart — click a button in the LATEST reply's carousel only
//    (scrollback carousels stay live DOM; clicking them measures stale data)
js(`(() => { const m=[...document.querySelectorAll('${OUT_SEL}')].pop(); const scope = m||document; const b = [...scope.querySelectorAll('.janis-wcard .janis-wbtn')].find(x => /add to cart/i.test(x.textContent) && !x.disabled); if (b) { b.click(); return b.closest('.janis-wcard').querySelector('.janis-wcard-t').textContent; } return null; })()`);
console.log('  clicked Add to cart on first card');
await sleep(2000);
const addedTitle = js(`(() => { const m=[...document.querySelectorAll('.janis-msg.in')].pop(); return m?m.innerText.slice(0,120):'' })()`);
console.log('  my tap message:', addedTitle);
await waitFor(`document.querySelectorAll('.janis-msg.out:not(.typing)').length > ${await outCount()}`, 75_000, 'add confirmation');
await sleep(1500);
const confirmReply = js(`(() => { const m=[...document.querySelectorAll('.janis-msg.out:not(.typing)')].pop(); return m?m.innerText.slice(0,300):'' })()`);
console.log('  agent says:', confirmReply.replace(/\n+/g, ' | '));
const denied = /out of stock|couldn't|could not|failed|unavailable|wasn't able/i.test(confirmReply);
console.log(denied ? '  ✗ STILL DENIES THE CONFIRMED ADD' : '  ✓ confirmed the add');

// 3. cart.js truth — what does the real cart hold?
const cart = js(`(async () => { const c = await fetch('/cart.js').then(r=>r.json()); window.__cart = c; return 'ok'; })()`);
await sleep(1200);
const cartState = js(`JSON.stringify({n: window.__cart?.item_count, items: (window.__cart?.items||[]).map(i=>i.title+' x'+i.quantity), total: window.__cart?.total_price/100})`);
console.log('  real cart:', cartState);

// 4. cart widget — "show me my cart" should hydrate real items
await send('show me my cart');
await sleep(2000);
const s4 = snap('cart widget');
console.log(`  cart rows rendered: ${s4.cartRows} | body: ${(s4.cartBody||'').replace(/\n+/g,' | ').slice(0,140)}`);

// 5. completeness ask — first-K-of-N narration + tile
await send('show me every product you have');
snap('all products');

// 6. load more via tile click → next page (scope to the LATEST reply —
//    earlier tiles stay live DOM in the scrollback)
const hasMore = js(`(() => { const m=[...document.querySelectorAll('${OUT_SEL}')].pop(); const t=m?.querySelector('.janis-wmore'); if(t){t.click();return true} return false; })()`);
if (hasMore === 'true') {
  console.log('  clicked the tile — waiting for page 2');
  await waitFor(`document.querySelectorAll('.janis-msg.out:not(.typing)').length > ${await outCount()}`, 75_000, 'page 2 reply');
  await sleep(2000);
  snap('after load-more');
} else {
  console.log('  no load-more tile on latest reply');
}

// 7. the reported failure — "in stock" ask must not badge-mismatch
await send('show me your items that are in stock');
const s7 = snap('in-stock ask');
const badged = (s7.cards || []).filter((c) => c.stock && /out/i.test(c.stock)).length;
console.log(`  cards: ${(s7.cards||[]).length}, out-of-stock badged: ${badged}`);

// 8. tap "show me more" again if a tile exists — chain walk must not repeat
const hasMore2 = js(`(() => { const m=[...document.querySelectorAll('${OUT_SEL}')].pop(); const t=m?.querySelector('.janis-wmore'); if(t){t.click();return true} return false; })()`);
if (hasMore2 === 'true') {
  await waitFor(`document.querySelectorAll('.janis-msg.out:not(.typing)').length > ${await outCount()}`, 75_000, 'page-3 reply');
  await sleep(2000);
  snap('after second load-more');
}

// 9. specific out-of-stock product — badged card, no Add button
await send('do you have the out of stock snowboard');
const s9 = snap('oos-specific');
console.log(`  oos card stock label: ${JSON.stringify((s9.cards||[]).map(c=>c.stock))}`);

// 9b. the subscription product — options line, "from" price, NO Add button
await send('tell me about the selling plans ski wax');
const s9b = snap('selling-plans product');
const wax = (s9b.cards || []).find((c) => /ski wax/i.test(c.t || ''));
console.log(`  wax card: price=${wax?.p} opts=${wax?.opts} btns=${JSON.stringify(wax?.btns)}`);
console.log(wax && !/add to cart/i.test((wax.btns || []).join(' ')) ? '  ✓ no silent add on a plans product' : '  ✗ ADD BUTTON ON A PLANS PRODUCT');

// 10. hallucination probe
await send('do you have a flying snowboard');
snap('nonexistent product');

// 11. price-sensitive ask — narration must defer to card price
await send("what's your cheapest product");
snap('cheapest');

console.log('\nDone — window stays yours.');
