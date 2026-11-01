// Marketing screenshots for the landing page — captures console surfaces
// clipped to .main at 1440x900 @2x → apps/web/public/img/marketing-*.png.
// Data source: local janis_dev "Meridian Airways" workspace (admin needs a temp
// membership there — add before running, remove after).
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import { BASE, EMAIL, PASSWORD } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'apps/web/public/img');
const WS = '83ca6ae2-d76d-42e3-8f03-46b97405dfb2'; // Meridian Airways
const CONSOLE_CONV = 'eeeb4277-d056-4f0c-8a93-19392fd0fbe1'; // Dana Whitfield — live pending fee-waiver approval
const TESTS_AGENT = '583260b5-a56f-4039-87e6-ca751a6f2ce1'; // Guest Support

const SHOTS = [
  ['marketing-console.png', `/conversations/${CONSOLE_CONV}`],
  ['marketing-inbox.png', '/conversations'],
  ['marketing-tests.png', `/agents/${TESTS_AGENT}/tests`],
  ['marketing-reports.png', '/reports'],
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const req = ctx.request;
const login = await req.post(`${BASE}/auth/login`, {
  data: { email: EMAIL, password: PASSWORD },
});
if (!login.ok()) throw new Error(`login: ${login.status()}`);
const sw = await req.post(`${BASE}/auth/switch`, { data: { workspace_id: WS } });
if (!sw.ok()) throw new Error(`switch: ${sw.status()} ${await sw.text()}`);

const page = await ctx.newPage();
// chrome-free shots: discovery card + push banner dismissed up front
await page.addInitScript(() => {
  localStorage.setItem('janis_discovery_dismissed', '1');
});
for (const [file, url] of SHOTS) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  await page.locator('.push-banner-dismiss').click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // wait for every rendered image to finish (or fail) so no grey boxes leak in
  await page.evaluate(() =>
    Promise.all(
      [...document.images].map((i) =>
        i.complete ? Promise.resolve() : i.decode().catch(() => {}),
      ),
    ),
  );
  const box = await page.locator('.main').boundingBox();
  if (!box) throw new Error(`no .main on ${url}`);
  await page.screenshot({ path: path.join(OUT, file), clip: box });
  console.log(`${file} <- ${url} (${Math.round(box.width)}x${Math.round(box.height)})`);
}
await browser.close();
