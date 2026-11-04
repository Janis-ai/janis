// Bulk-bar QA: desktop + mobile selected-state screenshots and measurements.
import { chromium } from 'playwright';
import { BASE, EMAIL, PASSWORD, shot } from './lib.mjs';

const run = async (width, height, mobile) => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height },
    hasTouch: mobile,
    isMobile: mobile,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const res = await context.request.post(`${BASE}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!res.ok()) throw new Error(`login ${res.status()}`);
  await page.goto(`${BASE}/conversations`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.conv-row', { timeout: 15000 });

  if (mobile) {
    // Long-press the first row: touchstart, hold 600ms, touchend.
    const row = page.locator('.conv-row').first();
    const box = await row.boundingBox();
    await page.touchscreen.tap(box.x + 100, box.y + 10); // ensure touch ctx ok — tap may navigate; undo below
    await page.goBack({ waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForSelector('.conv-row', { timeout: 15000 });
    await row.dispatchEvent('touchstart');
    await page.waitForTimeout(600);
    await row.dispatchEvent('touchend');
    await page.waitForTimeout(300);
  } else {
    await page.locator('.conv-check').first().check();
  }
  await page.waitForSelector('.bulk-bar', { timeout: 5000 });

  const info = await page.evaluate(() => {
    const bar = document.querySelector('.bulk-bar');
    const items = [...bar.querySelectorAll('.bulk-actions > *')];
    const rect = (el) => {
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x * 10) / 10, w: Math.round(b.width * 10) / 10, cy: Math.round((b.y + b.height / 2) * 10) / 10 };
    };
    const barB = bar.getBoundingClientRect();
    return {
      bar: rect(bar),
      check: rect(bar.querySelector('.check')),
      close: rect(bar.querySelector('.bulk-close')),
      slots: items.map((el) => ({ cls: el.className, ...rect(el) })),
      barH: Math.round(barB.height * 10) / 10,
    };
  });
  console.log(JSON.stringify(info, null, 1));
  await shot(page, mobile ? 'bulk-mobile' : 'bulk-desktop');
  await browser.close();
};

await run(1440, 900, false);
await run(390, 844, true);
