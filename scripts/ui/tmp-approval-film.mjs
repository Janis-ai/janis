// Records the approval-gate flow for the landing hero: open the staged
// Dana Whitfield conversation (live pending issue_refund card), approve it,
// and hold while the tool executes + the agent resumes. Playwright video
// → /tmp/janis-vid2/approve.webm, then ffmpeg converts to mp4.
import { chromium } from 'playwright';
import { BASE, EMAIL, PASSWORD } from './lib.mjs';

const WS = '83ca6ae2-d76d-42e3-8f03-46b97405dfb2'; // Meridian Airways
const CONV = 'eeeb4277-d056-4f0c-8a93-19392fd0fbe1'; // Dana Whitfield

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: '/tmp/janis-vid2', size: { width: 1440, height: 900 } },
});
const req = ctx.request;
const login = await req.post(`${BASE}/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
if (!login.ok()) throw new Error(`login: ${login.status()}`);
const sw = await req.post(`${BASE}/auth/switch`, { data: { workspace_id: WS } });
if (!sw.ok()) throw new Error(`switch: ${sw.status()}`);

const page = await ctx.newPage();
await page.addInitScript(() => localStorage.setItem('janis_discovery_dismissed', '1'));
await page.goto(`${BASE}/conversations/${CONV}`, { waitUntil: 'networkidle' });
await page.locator('.push-banner-dismiss').click({ timeout: 3000 }).catch(() => {});

// Let the pending card settle on camera.
await page.locator('text=Approve & run').waitFor({ timeout: 10000 });
await page.waitForTimeout(2500);

// The payoff: approve → tool executes (GET /health 200) → agent resumes.
await page.locator('button:has-text("Approve & run")').first().click();

// Card flips to its decided state, then the agent's follow-up lands via SSE.
await page.waitForTimeout(3000);
// Wait for a new outbound bubble after the card (the resumed agent reply).
await page.waitForTimeout(12000);
await page.waitForTimeout(2000);

await ctx.close();
await browser.close();
console.log('video in /tmp/janis-vid2');
