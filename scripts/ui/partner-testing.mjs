import { chromium } from 'playwright';
const OUT = '/tmp/partner';
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);
const cur = await page.locator('textarea[name="testingInstructions"]').inputValue();
console.log('CURRENT:\n' + cur);
const next = `1. Sign in at https://app.janis.ai with the test account above (workspace: SnowboardsAreUs — a dev store, snowboardsareus.myshopify.com, has the app already installed).

2. THEME APP EXTENSION / ONBOARDING: After installing Janis on a store, enable the storefront chat bubble from the Shopify theme editor: Online Store → Customize → App embeds → toggle "Janis" on → Save. The bubble then appears on every storefront page. Merchants manage the agent, knowledge base, inbox, and channels inside the embedded app (Apps → Janis) or at app.janis.ai.

3. Test the visitor flow: open the store's chat bubble (or the hosted chat link in Channels), ask "do you have boards for beginners?" — the agent replies with real catalog products and an add-to-cart card.

4. Test order lookup: ask "where is my order?" — the agent verifies the customer by email code, then returns live order status.

5. Test human takeover: in the Janis Inbox, open the new conversation, click Take over, reply as a human, then Resume the agent.

6. Screenshots and a screencast of this exact flow are attached above; the screencast URL also plays the end-to-end install → chat → takeover sequence.`;
await page.locator('textarea[name="testingInstructions"]').fill(next);
await page.waitForTimeout(600);
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click());
await page.waitForTimeout(6000);
console.log('saved:', await page.evaluate(() => (document.body.innerText.match(/(\d+) issues?/) || [])[0] ?? 'no issues'));
await ctx.close();
