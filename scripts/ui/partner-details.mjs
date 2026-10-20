import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const details = `Janis is an AI customer-support agent for your store. It lives in a chat bubble on your storefront, answers shoppers instantly, pulls live data from your catalog and orders, and escalates to your team when a human should step in.

Sell more. Product recommendations render as rich cards with images, variants, prices, and one-click add-to-cart links. The agent can build a checkout for the shopper and drop the link right in chat. Guided flows collect preferences (budget, experience, style) and recommend the right product, collecting an email or phone for follow-up along the way.

Support better. "Where's my order?" Janis verifies the customer with a one-time email code, then pulls live order status and tracking. Returns and warranty requests run as guided, step-by-step flows: the agent gathers the details, confirms the order, and files the request. Answers come from your knowledge base — store policies, FAQs, and content you teach it — and Janis tracks its own knowledge gaps so you always know what to teach next.

Stay in control. Monitor conversations live, reply as yourself, then hand the thread back to the agent — the customer never feels the seam. One shared inbox covers every channel: web chat, Facebook Messenger, Instagram, WhatsApp, and email. Escalation alerts go to email and Slack, and every action the agent takes is logged for review.

Setup takes minutes: install the app, and Janis deploys a storefront chat agent trained on your catalog — no theme edits, no code.`;
await page.locator('textarea[name="appDetails"]').fill(details);
await page.waitForTimeout(600);
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
await page.waitForTimeout(6000);
console.log('saved:', await page.evaluate(() => (document.body.innerText.match(/(\d+) issues?/) || [])[0] ?? 'no issues'));
await ctx.close();
