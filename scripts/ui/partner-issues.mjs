import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const r = await page.evaluate(() => {
  const links = [...document.querySelectorAll('a, button, [role="link"]')].map(e => e.textContent.trim()).filter(t => t && t.length < 120);
  const issuesEls = [...document.querySelectorAll('[class*="issue" i], [class*="Issue"], [class*="error" i] li, [class*="Error"]')].map(e => e.textContent.trim()).filter(t => t.length > 3 && t.length < 200);
  // better: the issues banner usually lists items
  const all = document.body.innerText;
  const lines = all.split('\n').map(s => s.trim()).filter(s => s.match(/required|missing|must|add|issue/i) && s.length < 150);
  return { issueCount: (all.match(/(\d+) issues?/) || [])[0], lines: [...new Set(lines)].slice(0, 40) };
});
console.log(JSON.stringify(r, null, 1));
await ctx.close();
