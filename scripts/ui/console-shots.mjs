// Console listing screenshots — authed via minted session cookies against
// prod. Usage: MAIN_TOKEN=… SNOW_TOKEN=… node scripts/ui/console-shots.mjs
import { chromium } from 'playwright';

const BASE = 'https://app.janis.ai';
const OUT = 'docs/listing-assets';
const COOKIE = (t) => ({
  name: 'janis_session', value: t, domain: 'app.janis.ai', path: '/',
  httpOnly: true, secure: true, sameSite: 'Lax',
});

const main = process.env.MAIN_TOKEN;
const snow = process.env.SNOW_TOKEN;
if (!main || !snow) { console.error('need MAIN_TOKEN + SNOW_TOKEN'); process.exit(1); }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

const shot = async (token, path, wait, file) => {
  const page = await ctx.newPage();
  await ctx.clearCookies();
  await ctx.addCookies([COOKIE(token)]);
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(wait, { timeout: 20000 });
  // kill the push-activation banner — it overlays the composer in shots
  await page.click('.push-banner-dismiss').catch(() => {});
  await page.waitForTimeout(2500); // settle — images, stream, layout
  await page.screenshot({ path: `${OUT}/${file}` });
  console.log('shot', file);
  await page.close();
};

// inbox thread with internal note (SnowboardsAreUs — collect-form thread)
await shot(
  snow,
  '/conversations/e5a35ea0-1fd7-46d5-97f2-e21e6cbd74f1',
  'textarea, [class*="composer"], [class*="msg"]',
  'shot-inbox-notes.png',
);

// agent editor — knowledge panel (SnowboardsAreUs workspace)
await shot(
  snow,
  '/agents/51a81b16-f6a1-4dfa-ac83-15e116690269/knowledge',
  'main, [class*="section"], form',
  'shot-agent-knowledge.png',
);

await browser.close();
