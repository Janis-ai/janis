import { execFileSync } from 'node:child_process';
const SHOP = 'janis-store-sx5bpcd3.myshopify.com';
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
    try { return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim(); }
    catch (e) { lastErr = e; execFileSync('sleep', ['0.3']); }
  }
  throw lastErr;
}
function js(code) {
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  for (let a = 0; a < 5; a++) {
    const ref = tabRef(); const [w, t] = ref.split(':');
    try {
      return execFileSync('osascript', ['-e', `tell application "Google Chrome" to tell tab ${t} of window ${w} to execute javascript "eval(atob(\\"${b64}\\\"))"`], { encoding: 'utf8', maxBuffer: 4*1024*1024 }).trim();
    } catch (e) { if (!/Invalid index|Can't get tab|1719|1728/.test(String(e.stderr||e))) throw e; execFileSync('sleep',['0.4']); }
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, timeout = 75000) {
  const s = Date.now();
  while (Date.now() - s < timeout) { if (js(`!!(${pred})`) === 'true') return; await sleep(700); }
  throw new Error('timeout: ' + pred.slice(0,60));
}
async function send(text) {
  console.log('→', text);
  js(`(() => { const i = document.querySelector('#janis-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input',{bubbles:true})); return i.value; })()`);
  js(`document.querySelector('#janis-send').click()`);
  const before = Number(js(`document.querySelectorAll('${OUT_SEL}').length`));
  await waitFor(`document.querySelectorAll('${OUT_SEL}').length > ${before}`);
  await sleep(2500);
}
function snap(label) {
  const s = js(`JSON.stringify((() => {
    const m = [...document.querySelectorAll('${OUT_SEL}')].pop();
    const scope = m || document;
    return { reply: m ? m.innerText.replace(/\\n+/g,' | ').slice(0,180) : null,
      cards: [...scope.querySelectorAll('.janis-wcard')].map(c => ({t: c.querySelector('.janis-wcard-t')?.textContent, stock: c.querySelector('.janis-wcard-stock')?.textContent || null, btns: [...c.querySelectorAll('.janis-wbtn')].map(b=>b.textContent.slice(0,14))})),
      more: scope.querySelector('.janis-wmore')?.textContent || null };
  })())`);
  console.log(`[${label}]`, s);
  return JSON.parse(s);
}
js(`document.querySelector('#janis-bubble')?.click(); 'x'`);
await sleep(1200);
await waitFor(`!!document.querySelector('#janis-input')`, 15000);
await send('show me your items that are in stock');
const s1 = snap('in-stock');
const titles = (s1.cards||[]).map(c=>c.t);
console.log('cards:', titles.length, '| 3p present:', titles.some(t=>/3p/i.test(t||'')), '| badged:', (s1.cards||[]).filter(c=>c.stock).length);
await send('show me all your products');
const s2 = snap('browse');
console.log('browse cards:', (s2.cards||[]).length, '| 3p badged:', JSON.stringify((s2.cards||[]).find(c=>/3p/i.test(c.t||''))?.stock));
