import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
const navW = async () => await page.evaluate(() => {
  const sb = document.querySelector('.sidebar');
  const r = sb.getBoundingClientRect();
  return `w=${Math.round(r.width)} right=${Math.round(r.right)} mini=${sb.classList.contains('mini')}`;
});
for (const w of [760, 730, 721, 720, 700, 721, 760, 1000]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(300);
  console.log(w + ': ' + await navW());
}
await browser.close();
