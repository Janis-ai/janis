// Probe: cold-load skeletons. Delays the single-conv GET and the inbox
// list GET so the placeholder UI is observable, screenshots at desktop
// and phone widths.
import { launch, login, shot, BASE } from './lib.mjs';

const { browser, context, page } = await launch();
await login(context);

// Grab a real conversation URL from the inbox first.
await page.goto(`${BASE}/conversations`, { waitUntil: 'networkidle' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
const href = await page.locator('.conv-row').first().getAttribute('href');

const singleConv = /\/api\/conversations\/[^/?#]+$/;
const convList = /\/api\/conversations(\?|$)/;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
await page.route('**/*', async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname + new URL(req.url()).search;
  if (req.method() === 'GET' && (singleConv.test(path) || convList.test(path))) {
    await delay(1600);
  }
  return route.continue();
});

// 1. Cold-open a conversation — the full .conv-layout skeleton shows.
await page.goto(`${BASE}${href}`);
await page.waitForSelector('.conv-layout .skel', { timeout: 8000 }).catch(() => console.log('FAIL: no conv skeleton'));
const conv = await page.evaluate(() => ({
  inboxCol: !!document.querySelector('.conv-inbox .skel-avatar'),
  headField: !!document.querySelector('.conv-mobile-head .skel-field'),
  actionIcons: document.querySelectorAll('.conv-actions .skel-ic').length,
  bubbles: document.querySelectorAll('.transcript .skel-msg').length,
  sideCards: document.querySelectorAll('.conv-side .skel-card').length,
  composer: !!document.querySelector('.skel-composer'),
  voidText: document.body.innerText.trim().length < 400,
}));
console.log('conv skeleton:', JSON.stringify(conv));
await page.waitForTimeout(250);
await shot(page, 'skel-conv-desktop');

// 2. Standalone inbox list — skeleton rows instead of the spinner text.
await page.goto(`${BASE}/conversations`);
await page.waitForSelector('.conv-list .skel-row', { timeout: 8000 }).catch(() => console.log('FAIL: no inbox skeleton'));
const inbox = await page.evaluate(() => ({
  skelRows: document.querySelectorAll('.conv-list .skel-row').length,
  spinners: document.querySelectorAll('.conv-list .spin').length,
  loadingText: document.body.innerText.includes('Loading conversations…'),
}));
console.log('inbox skeleton:', JSON.stringify(inbox));
await page.waitForTimeout(250);
await shot(page, 'skel-inbox-desktop');
await page.waitForSelector('.conv-list .conv-row:not(.skel-row)', { timeout: 8000 });
await shot(page, 'inbox-loaded-desktop');

// 3. Phone width — conv skeleton adapts (inbox col + rail drop out).
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}${href}`);
await page.waitForSelector('.conv-layout .skel', { timeout: 8000 }).catch(() => console.log('FAIL: no mobile skeleton'));
const mob = await page.evaluate(() => ({
  inboxVisible: !!document.querySelector('.conv-inbox')?.offsetParent,
  headField: !!document.querySelector('.conv-mobile-head .skel-field'),
  bubbles: document.querySelectorAll('.transcript .skel-msg').length,
}));
console.log('mobile conv skeleton:', JSON.stringify(mob));
await page.waitForTimeout(250);
await shot(page, 'skel-conv-mobile');
await browser.close();
