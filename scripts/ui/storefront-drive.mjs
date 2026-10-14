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
      if URL of tab t of window w contains "${SHOP}" and URL of tab t of window w does not contain "admin.shopify" then return (w & ":" & t) as text
    end repeat
  end repeat
  return "0:0"
end tell`;
  const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
  return out;
}

/** Run JS in the storefront tab; returns the string result (eval last expr). */
function js(code) {
  const ref = tabRef();
  if (ref === '0:0') throw new Error('no storefront tab open');
  const [w, t] = ref.split(':');
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  const out = execFileSync('osascript', [
    '-e',
    `tell application "Google Chrome" to tell tab ${t} of window ${w} to execute javascript "eval(atob(\\"${b64}\\\"))"`,
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return out.trim();
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
js(`document.querySelector('#janis-bubble')?.click(); 'opened'`);
await sleep(1200);
await waitFor(`document.querySelector('#janis-input')`, 10_000, 'input');
console.log('panel open — starting battery (watch your window)\n');

// 1. browse — cards + Add to cart buttons (storefront!) + 10-of-13 tile
await send('show me your products');
const s1 = snap('after browse');
console.log(`  ✓ add-to-cart buttons: ${s1.addBtns}, tile: ${s1.more}`);

// 2. add-to-cart — click the first card's button, verify agent confirms
js(`(() => { const b = [...document.querySelectorAll('.janis-wcard .janis-wbtn')].find(x => /add to cart/i.test(x.textContent) && !x.disabled); if (b) { b.click(); return b.closest('.janis-wcard').querySelector('.janis-wcard-t').textContent; } return null; })()`);
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

// 6. load more via tile click → next page
if (js(`!!document.querySelector('.janis-wmore')`) === 'true') {
  js(`document.querySelector('.janis-wmore').click()`);
  console.log('  clicked the tile — waiting for page 2');
  await waitFor(`document.querySelectorAll('.janis-msg.out:not(.typing)').length > ${await outCount()}`, 75_000, 'page 2 reply');
  await sleep(2000);
  snap('after load-more');
}

console.log('\nDone — window stays yours.');
