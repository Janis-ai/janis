// Probe: sample DOM state at 50ms intervals across a conversation switch
// while the single-conv GET is delayed ~1.2s. Tells us exactly what renders
// in the placeholder window: pill, fade, full-page gate, or stale content.
import { launch, login, shot, BASE } from './lib.mjs';

const { browser, context, page } = await launch();
await login(context);
await page.goto(`${BASE}/conversations`, { waitUntil: 'networkidle' });
await page.waitForSelector('.conv-row', { timeout: 15000 });

await page.locator('.conv-row').first().click();
await page.waitForSelector('.transcript .msg', { timeout: 15000 });
const urlA = page.url();

const singleConv = /\/api\/conversations\/[^/?#]+$/;
let delayed = 0;
await page.route('**/*', async (route) => {
  const req = route.request();
  if (req.method() === 'GET' && singleConv.test(new URL(req.url()).pathname)) {
    delayed++;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return route.continue();
});

await page.locator('.conv-row:not(.sel)').first().click();

const samples = [];
for (let i = 0; i < 40; i++) {
  samples.push(await page.evaluate(() => ({
    t: performance.now() | 0,
    url: location.pathname,
    pill: !!document.querySelector('.conv-fetch'),
    switching: document.querySelector('.transcript')?.classList.contains('switching') ?? null,
    main: !!document.querySelector('.conv-main'),
    msgs: document.querySelectorAll('.transcript .msg').length,
    gate: !document.querySelector('.conv-main'),
    firstMsg: document.querySelector('.transcript .msg')?.textContent?.slice(0, 24) ?? null,
  })));
  if (i === 8) await shot(page, 'conv-switch-loading');
  await page.waitForTimeout(60);
}
const urlB = page.url();
console.log('navigated:', urlA, '→', urlB, '| delayed fetches:', delayed);
for (const s of samples) {
  if (s.pill || s.gate || !s.main || s.switching) console.log('signal:', JSON.stringify(s));
}
console.log('first:', JSON.stringify(samples[0]));
console.log('last:', JSON.stringify(samples[samples.length - 1]));
await shot(page, 'conv-switch-probe');
await browser.close();
