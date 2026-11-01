// Responsive audit — screenshots + scroll hit-tests across widths/pages.
// node scripts/ui/responsive-audit.mjs → /tmp/rsc/*.png + JSON metrics.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { BASE, EMAIL, PASSWORD } from './lib.mjs';

const OUT = '/tmp/rsc';
mkdirSync(OUT, { recursive: true });
const WIDTHS = [390, 750, 1000, 1440];
const PAGES = [
  ['inbox', '/conversations'],
  ['agents', '/agents'],
  ['contacts', '/contacts'],
  ['reports', '/reports'],
  ['settings', '/settings'],
];

const b = await chromium.launch({ headless: true });
const report = [];
for (const w of WIDTHS) {
  const c = await b.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: 1, hasTouch: w <= 750 });
  const p = await c.newPage();
  const r = await c.request.post(`${BASE}/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
  if (!r.ok()) throw new Error('login');
  // discover a conversation URL for the conv-page test
  let convUrl = null;
  for (const [name, url] of PAGES) {
    await p.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(700);
    if (name === 'inbox') convUrl = await p.evaluate(() => document.querySelector('.conv-row a, a.conv-row')?.getAttribute('href'));
    const metrics = await p.evaluate(() => {
      const xOver = document.documentElement.scrollWidth - innerWidth;
      const scrollables = [...document.querySelectorAll('*')].filter(e => {
        const s = getComputedStyle(e);
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 4 && e.clientHeight > 40;
      }).map(e => e.className.toString().split(' ')[0] || e.tagName);
      // wheel test: dispatch a wheel over the main content hit area
      const main = document.querySelector('.main');
      let scrolled = null;
      if (main) {
        const target = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        const before = new Map();
        for (const el of document.querySelectorAll('.main, .conv-list, .transcript, .conv-side')) before.set(el, el.scrollTop);
        target?.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true }));
        main.scrollTop += 0; // noop — wheel may not fire synth scroll
      }
      return { xOver, scrollables: [...new Set(scrollables)] };
    });
    // real scroll test: set scrollTop on the main region and see if the page accepts it
    const scrollTest = await p.evaluate(() => {
      const main = document.querySelector('.main');
      if (!main) return {};
      const canMain = main.scrollHeight > main.clientHeight;
      const convList = document.querySelector('.conv-list');
      return {
        mainScrollable: canMain,
        convListScrollable: convList ? convList.scrollHeight > convList.clientHeight : null,
      };
    });
    await p.screenshot({ path: `${OUT}/${name}-${w}.png` });
    report.push({ page: name, w, ...metrics, ...scrollTest });
  }
  if (convUrl) {
    await p.goto(`${BASE}${convUrl}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(1000);
    const metrics = await p.evaluate(() => {
      const xOver = document.documentElement.scrollWidth - innerWidth;
      const t = document.querySelector('.transcript');
      const f = document.querySelector('.conv-foot');
      const m = document.querySelector('.main');
      const main = m ? { overflow: getComputedStyle(m).overflowY, scrollable: m.scrollHeight > m.clientHeight } : null;
      const footVisible = f ? f.getBoundingClientRect().top < innerHeight && f.getBoundingClientRect().bottom <= innerHeight + 1 : null;
      return { xOver, transcriptScrollable: t ? t.scrollHeight > t.clientHeight : null, main, footVisible };
    });
    await p.screenshot({ path: `${OUT}/conv-${w}.png` });
    report.push({ page: 'conv', w, ...metrics });
  }
  await c.close();
}
console.log(JSON.stringify(report, null, 1));
await b.close();
