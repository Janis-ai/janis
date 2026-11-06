import { launch, login } from './lib.mjs';
const { browser, page } = await launch();
await login(page);
await page.goto('http://localhost:5173/conversations', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.conv-row', { timeout: 15000 });
await page.locator('.conv-row').nth(2).click();
await page.waitForSelector('.conv-main', { timeout: 10000 });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);
const pos = async (sel) => await page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el || getComputedStyle(el).display === 'none') return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };
}, sel);
const state = async (tag) => {
  const collapse = await pos('.cmh-collapse');
  const info = await pos('.cmh-info:not(.cmh-copilot)');
  const rail = await page.evaluate(() => {
    const el = document.querySelector('.conv-side');
    return el && getComputedStyle(el).display !== 'none' ? Math.round(el.getBoundingClientRect().width) : 'X';
  });
  console.log(tag, `rail=${rail} collapse=${JSON.stringify(collapse)} info=${JSON.stringify(info)}`);
};
await state('docked:');
await page.locator('.cmh-collapse').click();
await page.waitForTimeout(400);
await state('closed:');
await page.locator('.cmh-info:not(.cmh-copilot)').click();
await page.waitForTimeout(400);
await state('reopened:');
await browser.close();
