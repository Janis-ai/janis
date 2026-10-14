// Targeted probes on the running conversation — no reset.
import { execFileSync } from 'node:child_process';
const SHOP = 'janis-store-sx5bpcd3.myshopify.com';
function tabRef() {
  const s = `tell application "Google Chrome"
  repeat with w from 1 to count windows
    repeat with t from 1 to count tabs of window w
      try
        if URL of tab t of window w contains "${SHOP}" and URL of tab t of window w does not contain "admin.shopify" then return (w & ":" & t) as text
      end try
    end repeat
  end repeat
  return "0:0"
end tell`;
  for (let i = 0; i < 8; i++) {
    try { return execFileSync('osascript', ['-e', s], { encoding: 'utf8' }).trim(); }
    catch { execFileSync('sleep', ['0.3']); }
  }
  return '0:0';
}
function js(code) {
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  let lastErr;
  for (let a = 0; a < 5; a++) {
    const ref = tabRef(); if (ref === '0:0') throw new Error('no tab');
    const [w, t] = ref.split(':');
    try {
      return execFileSync('osascript', ['-e',
        `tell application "Google Chrome" to tell tab ${t} of window ${w} to execute javascript "eval(atob(\\"${b64}\\\"))"`],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
    } catch (e) {
      lastErr = e;
      if (!/Invalid index|Can't get tab|1719|1728/.test(String(e.stderr || e))) throw e;
      execFileSync('sleep', ['0.4']);
    }
  }
  throw lastErr;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = '.janis-msg.out:not(.typing)';
async function waitFor(pred, timeout, label) {
  const s = Date.now();
  while (Date.now() - s < timeout) { if (js(`!!(${pred})`) === 'true') return; await sleep(700); }
  throw new Error('timeout: ' + label);
}
async function send(text) {
  console.log(`\n→ ${text}`);
  const before = Number(js(`document.querySelectorAll('${OUT}').length`));
  js(`(() => { const i = document.querySelector('#janis-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  js(`document.querySelector('#janis-send').click()`);
  await waitFor(`document.querySelectorAll('${OUT}').length > ${before}`, 90000, 'reply');
  await waitFor(`(() => { const m=[...document.querySelectorAll('${OUT}')].pop(); return m && m.innerText.trim().length > 0; })()`, 30000, 'text');
  await sleep(2500);
  return js(`JSON.stringify((() => {
    const lastOut = [...document.querySelectorAll('${OUT}')].pop();
    return {
      replyText: lastOut.innerText.replace(/\\n+/g,' | ').slice(0,260),
      cards: [...lastOut.querySelectorAll('.janis-wcard')].map(c => ({
        t: (c.querySelector('.janis-wcard-t')||{}).textContent,
        p: (c.querySelector('.janis-wcard-p')||{}).textContent || null,
        opts: [...c.querySelectorAll('.janis-wcard-s')].map(o => o.textContent).join(' | ') || null,
        stock: (c.querySelector('.janis-wcard-stock')||{}).textContent || null,
        btns: [...c.querySelectorAll('.janis-wbtn')].map(b => b.textContent.slice(0,20)),
      })),
    };
  })())`);
}
js(`document.querySelector('#janis-bubble')?.click(); 'ok'`);
await sleep(1000);
await waitFor(`!!document.querySelector('#janis-input')`, 15000, 'input');
for (const q of [
  'tell me about the selling plans ski wax',
  'show me your items that are in stock',
]) {
  const r = JSON.parse(await send(q));
  console.log('  reply:', r.replyText);
  for (const c of r.cards) console.log(`   card: ${c.t} | ${c.p} | ${c.stock ?? ''} | btns=${JSON.stringify(c.btns)} | opts=${c.opts}`);
}
console.log('\ndone');
