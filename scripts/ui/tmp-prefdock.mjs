import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.setViewportSize({ width: 1140, height: 900 });
// pin an expanded pref at THIS width — the pathological case
await page.evaluate(() => localStorage.setItem('nav.collapse', JSON.stringify({ v: 'expanded', vw: 1140 })));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.waitForTimeout(400);
const nav = async () => Math.round(await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().width));
console.log('pre-dock nav:', await nav());
await page.evaluate(() => window.dispatchEvent(new CustomEvent('janis:open-copilot')));
await page.waitForTimeout(800);
console.log(await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  return JSON.stringify({
    navW: Math.round(q('.sidebar').getBoundingClientRect().width),
    convW: Math.round(q('.conv-main').getBoundingClientRect().width),
    inboxW: q('.conv-inbox') ? Math.round(q('.conv-inbox').getBoundingClientRect().width) : null,
    sideD: getComputedStyle(q('.conv-side')).display,
    mr: getComputedStyle(q('.main')).marginRight,
  });
}));
await browser.close();
