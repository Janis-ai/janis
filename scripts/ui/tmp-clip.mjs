import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.setViewportSize({ width: 1140, height: 900 });
await page.evaluate(() => localStorage.setItem('nav.collapse', JSON.stringify({ v: 'expanded', vw: 1140 })));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.evaluate(() => window.dispatchEvent(new CustomEvent('janis:open-copilot')));
await page.waitForTimeout(800);
console.log(await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  return JSON.stringify({
    navW: Math.round(q('.sidebar').getBoundingClientRect().width),
    convl: Math.round(q('.conv-layout').clientWidth),
    convW: Math.round(q('.conv-main').getBoundingClientRect().width),
    inboxW: q('.conv-inbox')?.getBoundingClientRect().width | 0,
    side: q('.conv-side') ? { d: getComputedStyle(q('.conv-side')).display, w: Math.round(q('.conv-side').getBoundingClientRect().width), l: Math.round(q('.conv-side').getBoundingClientRect().left) } : null,
    cls: q('.conv-layout').className, mr: getComputedStyle(q('.main')).marginRight,
  });
}));
await browser.close();
