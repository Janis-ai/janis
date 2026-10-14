// scripts/ui — Playwright harness for driving the Janis UI.
// Not part of the workspaces build: plain .mjs run by node directly.
//
//   node scripts/ui/smoke.mjs           headless run against dev servers
//   UI_HEADED=1 node scripts/ui/smoke.mjs   watch it click in a real window
//
// Env: UI_BASE (default http://localhost:5173 — point at a preview or prod
// to test those), UI_EMAIL/UI_PASSWORD (seed admin defaults), UI_CHANNEL
// ('chrome' uses system Chrome instead of bundled chromium), UI_EXPECT_REPLY=1
// (fail when no agent reply arrives — off by default since a reply needs a
// configured LLM), UI_SLOW_MS (delay between actions when watching headed).

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = (process.env.UI_BASE ?? 'http://localhost:5173').replace(/\/$/, '');
export const EMAIL = process.env.UI_EMAIL ?? 'admin@janis.local';
export const PASSWORD = process.env.UI_PASSWORD ?? 'janis-admin';
export const SLOW_MS = Number(process.env.UI_SLOW_MS ?? 0);

const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

export async function launch() {
  const launchOpts = {
    headless: process.env.UI_HEADED !== '1',
    slowMo: SLOW_MS || undefined,
  };
  // UI_CHANNEL=chrome uses the installed browser; default is bundled chromium.
  if (process.env.UI_CHANNEL) launchOpts.channel = process.env.UI_CHANNEL;
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  return { browser, context, page };
}

/** Console login — POSTs through the vite /auth proxy so the session cookie
 *  lands in the browser context's jar. */
export async function login(context) {
  const res = await context.request.post(`${BASE}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!res.ok()) throw new Error(`login failed: HTTP ${res.status()} — ${await res.text()}`);
  return res.json();
}

let n = 0;
export async function shot(page, name) {
  const file = join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}
