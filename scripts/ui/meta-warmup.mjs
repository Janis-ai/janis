// Warm-up the persistent Chrome profile on monitor 2: operator logs into
// messenger.com / instagram.com / web.whatsapp.com and opens the demo threads
// ONCE — sessions persist for the real take. Ends when /tmp/meta-warmup-done
// exists; dumps each tab's URL to /tmp/meta-thread-urls.json.
import { chromium } from 'playwright';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';

const PROFILE = '/tmp/meta-chrome-profile';
mkdirSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false,
  args: ['--test-type', '--hide-crash-restore-bubble', '--disable-session-crashed-bubble'],
  viewport: null,
});
const p1 = ctx.pages()[0] ?? (await ctx.newPage());
const cdp = await ctx.newCDPSession(p1);
const { windowId } = await cdp.send('Browser.getWindowForTarget');
await cdp.send('Browser.setWindowBounds', {
  windowId,
  bounds: { windowState: 'normal', left: 2560, top: 1437, width: 2056, height: 1329 },
});

const p2 = await ctx.newPage();
const p3 = await ctx.newPage();
await p1.goto('https://www.messenger.com').catch(() => {});
await p2.goto('https://www.instagram.com/direct/inbox/').catch(() => {});
await p3.goto('https://web.whatsapp.com').catch(() => {});
await p1.bringToFront().catch(() => {});

console.log('>>> warm-up: log into messenger/IG, pair WA web, open the demo threads in each tab.');
console.log('>>> when all three threads are on screen: touch /tmp/meta-warmup-done');
while (!existsSync('/tmp/meta-warmup-done')) await p1.waitForTimeout(1500);

const urls = {};
for (const [key, p] of [['messenger', p1], ['instagram', p2], ['whatsapp', p3]]) {
  urls[key] = p.url();
}
writeFileSync('/tmp/meta-thread-urls.json', JSON.stringify(urls, null, 2));
console.log('urls:', JSON.stringify(urls, null, 2));
await ctx.close();
console.log('warm-up complete — profile persisted at', PROFILE);
