import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.setViewportSize({ width: 1140, height: 900 });
await page.waitForTimeout(400);
await page.evaluate(() => window.dispatchEvent(new CustomEvent('janis:open-copilot')));
await page.waitForTimeout(700);
console.log(await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const sb = q('.sidebar');
  return JSON.stringify({
    navW: Math.round(sb.getBoundingClientRect().width),
    mini: sb.className,
    convl: Math.round(q('.conv-layout').clientWidth),
    convW: Math.round(q('.conv-main').getBoundingClientRect().width),
    inboxW: q('.conv-inbox') ? Math.round(q('.conv-inbox').getBoundingClientRect().width) : null,
    sideD: getComputedStyle(q('.conv-side')).display,
    sideW: Math.round(q('.conv-side').getBoundingClientRect().width),
    marginR: getComputedStyle(q('.main')).marginRight,
    dockW: Math.round(q('.dock').getBoundingClientRect().width),
    navPref: localStorage.getItem('janis.nav.pref'),
  });
}));
await browser.close();
