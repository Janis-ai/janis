// Mobile audit — drive every console surface at phone-portrait size,
// screenshot each, and report horizontal overflow (scrollWidth > innerWidth)
// so breakage shows up as data, not just eyeballing.
//   node scripts/ui/mobile-audit.mjs          → shots into scripts/ui/out/mobile/
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, EMAIL, PASSWORD } from './lib.mjs';

const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'out', 'mobile');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: process.env.UI_HEADED !== '1' });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});
const page = await context.newPage();
const only = process.argv[2];

const res = await context.request.post(`${BASE}/auth/login`, {
  data: { email: EMAIL, password: PASSWORD },
});
if (!res.ok()) throw new Error(`login failed: HTTP ${res.status()}`);

const results = [];
async function visit(name, path, opts = {}) {
  if (only && !name.includes(only)) return;
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(opts.settle ?? 700);
  const m = await page.evaluate(() => ({
    url: location.pathname,
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  const overflow = m.sw - m.iw;
  results.push(`${overflow > 0 ? 'OVERFLOW' : 'ok     '} ${name.padEnd(18)} ${m.url}  +${Math.max(0, overflow)}px`);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: opts.full ?? false }).catch(() => {});
}

// Discover real ids — the audit needs a seeded workspace (demo agent).
await page.goto(`${BASE}/conversations`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const convHref = await page.locator('a.conv-row').first().getAttribute('href').catch(() => null);
await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' });
const agentHref = await page.locator('a[href^="/agents/"]:not([href*="new"])').first().getAttribute('href').catch(() => null);
const agentId = agentHref?.match(/\/agents\/([^/]+)/)?.[1];

await visit('00-login', '/login', { full: true });
await visit('01-landing', '/', { full: true });
await visit('02-inbox', '/conversations', { full: true });
if (convHref) await visit('03-conversation', convHref, { full: true });
if (agentId) {
  await visit('04-agent-overview', `/agents/${agentId}`, { full: true });
  await visit('05-agent-inbox', `/agents/${agentId}/inbox`, { full: true });
  await visit('06-agent-knowledge', `/agents/${agentId}/knowledge`, { full: true });
  await visit('07-agent-behavior', `/agents/${agentId}/behavior`, { full: true });
  await visit('08-agent-actions', `/agents/${agentId}/integrations`, { full: true });
  await visit('09-agent-tests', `/agents/${agentId}/tests`, { full: true });
  await visit('10-agent-channels', `/agents/${agentId}/channels`, { full: true });
  await visit('11-agent-settings', `/agents/${agentId}/settings`, { full: true });
  await visit('12-agent-builder', `/agents/new/${agentId}?step=try`, { full: true });
}
await visit('13-contacts', '/contacts', { full: true });
const contactHref = await page.locator('a[href^="/contacts/"]').first().getAttribute('href').catch(() => null);
if (contactHref) await visit('14-contact', contactHref, { full: true });
await visit('15-campaigns', '/campaigns', { full: true });
await visit('16-reports', '/reports', { full: true });
await visit('17-errors', '/errors', { full: true });
await visit('18-billing', '/billing', { full: true });
await visit('19-settings', '/settings', { full: true });
await visit('20-ask', '/ask', { full: true });
await visit('21-docs', '/docs', { full: true });
// The dock as a drawer — use the ?rail= deeplinks rather than the strip
// (the strip is hidden while the dock is open).
await visit('22-dock-copilot', '/conversations?rail=ask');
if (agentId) await visit('23-dock-test', `/agents/${agentId}?rail=test&agent=${agentId}`);

console.log(results.join('\n'));
await browser.close();
