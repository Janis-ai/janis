import { launch, login } from './lib.mjs';
const [w, dock] = [Number(process.argv[2]), process.argv[3] === 'dock'];
const { browser, page } = await launch();
await login(page);
await page.setViewportSize({ width: w, height: 900 });
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-mobile-head', { timeout: 15000 });
if (dock) await page.evaluate(() => window.dispatchEvent(new CustomEvent('janis:open-copilot')));
await page.waitForTimeout(900);
await page.evaluate(() => document.querySelector('.conv-mobile-head .cmh-info:not(.cmh-copilot)')?.click());
await page.waitForTimeout(500);
console.log(w, dock ? 'dock' : 'strip', await page.evaluate((w) => {
  const at = (x, y) => { const e = document.elementFromPoint(x, y); return e?.closest('.conv-side') ? 'drawer' : e?.closest('.dock') ? 'dock' : e?.classList.contains('conv-side-scrim') ? 'scrim' : (e?.className || e?.tagName || '').toString().slice(0, 30); };
  return JSON.stringify({ nav: at(30, 300), conv: at(200, 300), drawerEdge: at(w - 6, 300), dockArea: at(w - 100, 300) });
}, w));
await page.screenshot({ path: `scripts/ui/out/drawer-cover-${w}${dock ? '-dock' : ''}.png` });
await browser.close();
