import { chromium } from 'playwright';
import fs from 'fs';

const TOKEN = process.env.SNOW_TOKEN;
if (!TOKEN) { console.error('need SNOW_TOKEN (minted via scripts/tmp/mint-sb-session.ts)'); process.exit(1); }
const BASE = 'https://app.janis.ai';
const AG = '51a81b16-f6a1-4dfa-ac83-15e116690269';
const OUT = '/tmp/shopify-shots';
fs.mkdirSync(OUT, { recursive: true });

const shots = [
  ['01-inbox', '/conversations'],
  ['02-checkout-convo', `/agents/${AG}/inbox/b91fc7e2-9668-4037-8036-fca34d29d218`],
  ['03-return-convo', `/agents/${AG}/inbox/46aca2d9-059e-4800-8f5c-94700d1c2244`],
  ['04-sizing-convo', `/agents/${AG}/inbox/e5a35ea0-1fd7-46d5-97f2-e21e6cbd74f1`],
  ['05-agent', `/agents/${AG}`],
  ['06-channels', `/agents/${AG}/channels`],
];

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await ctx.addCookies([{ name: 'janis_session', value: TOKEN, domain: 'app.janis.ai', path: '/', secure: true, httpOnly: true }]);
const page = await ctx.newPage();
for (const [name, path] of shots) {
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(name, page.url());
  } catch (e) { console.log(name, 'ERR', e.message); }
}
await browser.close();
