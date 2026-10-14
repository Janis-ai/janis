// Probe the See-options picker: ask for the subscription wax, click
// "See options", snapshot the sheet, pick a plan, add to cart, verify
// /cart.js carries the selling_plan. Reuses the drive helpers inline.
import { execFileSync } from 'node:child_process';
const SHOP = process.env.SHOP_HOST ?? 'janis-store-sx5bpcd3.myshopify.com';
const OUT_SEL = '.janis-msg.out:not(.typing)';

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
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
    } catch (e) { lastErr = e; execFileSync('sleep', ['0.3']); }
  }
  throw lastErr;
}
function js(code) {
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = tabRef();
    if (ref === '0:0') throw new Error('no storefront tab open');
    const [w, t] = ref.split(':');
    try {
      return execFileSync('osascript', [
        '-e',
        `tell application "Google Chrome" to tell tab ${t} of window ${w} to execute javascript "eval(atob(\\"${b64}\\\"))"`,
      ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
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
const outCount = () => Number(js(`document.querySelectorAll('${OUT_SEL}').length`));

console.log('tab:', tabRef());
js(`document.querySelector('#janis-bubble')?.click(); 'opened'`);
await sleep(1200);

// baseline cart
js(`(async () => { window.__c0 = await fetch('/cart.js').then(r=>r.json()); return 'ok'; })()`);
await sleep(1000);
const c0 = js(`JSON.stringify({n: window.__c0.item_count, plans: (window.__c0.items||[]).map(i=>i.selling_plan_allocation?.selling_plan?.name||null)})`);
console.log('cart before:', c0);

// ask for the subscription product
const txt = 'tell me about the selling plans ski wax';
console.log('→', txt);
js(`(() => { const i = document.querySelector('#janis-input'); i.value = ${JSON.stringify(txt)}; i.dispatchEvent(new Event('input',{bubbles:true})); return i.value; })()`);
js(`document.querySelector('#janis-send').click()`);
const before = await outCount();
await waitFor(`document.querySelectorAll('${OUT_SEL}').length > ${before}`, 75_000, 'reply');
await sleep(2500);

const card = js(`JSON.stringify((() => {
  const m = [...document.querySelectorAll('${OUT_SEL}')].pop();
  const c = [...(m||document).querySelectorAll('.janis-wcard')].find(x => /ski wax/i.test(x.textContent));
  if (!c) return null;
  return { t: c.querySelector('.janis-wcard-t')?.textContent,
    p: c.querySelector('.janis-wcard-p')?.textContent,
    opts: [...c.querySelectorAll('.janis-wcard-s')].map(o=>o.textContent).join(' | '),
    btns: [...c.querySelectorAll('.janis-wbtn')].map(b=>b.textContent) };
})())`);
console.log('wax card:', card);

// click See options
const clicked = js(`(() => {
  const m = [...document.querySelectorAll('${OUT_SEL}')].pop();
  const c = [...(m||document).querySelectorAll('.janis-wcard')].find(x => /ski wax/i.test(x.textContent));
  const b = c && [...c.querySelectorAll('.janis-wbtn')].find(x => /see options/i.test(x.textContent));
  if (b) { b.click(); return true; } return false;
})()`);
console.log('clicked See options:', clicked);
if (clicked !== 'true') { console.log('✗ no See options button — bail'); process.exit(1); }
await waitFor(`document.querySelector('.janis-opts-sheet .janis-opts-add:not([disabled])') || document.querySelector('.janis-opts-add[disabled]')`, 15000, 'sheet');
await sleep(1000);

const sheet1 = js(`JSON.stringify((() => {
  const s = document.querySelector('.janis-opts-sheet');
  if (!s) return null;
  return {
    head: s.querySelector('.janis-opts-head')?.textContent?.trim(),
    price: s.querySelector('.janis-opts-price')?.textContent,
    labels: [...s.querySelectorAll('.janis-opts-label')].map(l=>l.textContent),
    pills: [...s.querySelectorAll('.janis-opts-pill')].map(p=>({v:p.textContent, sel:p.classList.contains('sel')})),
    plans: [...s.querySelectorAll('.janis-opts-plan')].map(l=>({t:l.textContent.trim(), on:l.querySelector('input')?.checked})),
    add: s.querySelector('.janis-opts-add')?.textContent,
  };
})())`);
console.log('sheet:', sheet1);

// pick the subscription plan on the preselected variant (it has the
// allocation — other variants may not offer every plan)
js(`(() => {
  const plans = [...document.querySelectorAll('.janis-opts-plan')];
  const sub = plans.find(l => /subscription/i.test(l.textContent));
  if (sub) sub.click();
  return !!sub;
})()`);
await sleep(800);
const sheet2 = js(`JSON.stringify((() => {
  const s = document.querySelector('.janis-opts-sheet');
  return { price: s?.querySelector('.janis-opts-price')?.textContent,
    plans: [...s.querySelectorAll('.janis-opts-plan')].map(l=>({t:l.textContent.trim().slice(0,60), on:l.querySelector('input')?.checked})),
    add: s?.querySelector('.janis-opts-add')?.textContent };
})())`);
console.log('after variant+plan pick:', sheet2);

// add
js(`document.querySelector('.janis-opts-add')?.click(); 'add'`);
await sleep(2500);
js(`(async () => { window.__c1 = await fetch('/cart.js').then(r=>r.json()); return 'ok'; })()`);
await sleep(1200);
const c1 = js(`JSON.stringify({n: window.__c1.item_count, items: (window.__c1.items||[]).map(i=>({t:i.title, v:i.variant_title, plan:i.selling_plan_allocation?.selling_plan?.name||null, price:i.final_price/100}))})`);
console.log('cart after:', c1);
const sheetGone = js(`!document.querySelector('.janis-opts-sheet')`);
console.log('sheet closed:', sheetGone);
console.log('\nDone.');
