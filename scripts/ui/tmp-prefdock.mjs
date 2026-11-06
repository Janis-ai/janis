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
// (appended) re-run fresh: after dock collapses nav, user expand must hold
const { browser: b2, page: p2 } = await launch();
await login(p2);
await p2.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await p2.setViewportSize({ width: 1140, height: 900 });
await p2.evaluate(() => localStorage.setItem('nav.collapse', JSON.stringify({ v: 'expanded', vw: 1140 })));
await p2.reload({ waitUntil: 'domcontentloaded' });
await p2.waitForSelector('.conv-row', { timeout: 15000 });
await p2.locator('.conv-row').nth(2).click();
await p2.waitForSelector('.conv-main', { timeout: 10000 });
await p2.evaluate(() => window.dispatchEvent(new CustomEvent('janis:open-copilot')));
await p2.waitForTimeout(700);
const w2 = () => p2.evaluate(() => Math.round(document.querySelector('.sidebar').getBoundingClientRect().width));
console.log('after-dock nav:', await w2());
await p2.locator('.nav-collapse').click();
await p2.waitForTimeout(400);
console.log('after-user-expand nav:', await w2());
await b2.close();
