import { chromium } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/partner';
fs.mkdirSync(OUT, { recursive: true });
const ctx = await chromium.launchPersistentContext('/tmp/partner-profile', { headless: true, channel: 'chrome', viewport: { width: 1600, height: 1400 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://apps.shopify.com/services/partner-app-submissions/bbc74ee5092894c6b45e93e24db1ede6/en', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(8000);

const set = async (name, val) => {
  const el = page.locator(`[name="${name}"]`).first();
  if (await el.count()) { await el.fill(val); console.log('set', name); }
  else console.log('MISSING', name);
};

await set('appName', 'Janis — AI Agent');
await set('appIntroduction', 'AI agent that answers shoppers, finds products, looks up orders, and hands off to your team.');
await set('appDetails', `Janis is an AI customer-support agent for your Shopify store. It lives in a chat bubble on your storefront, answers shoppers instantly, pulls live data from your catalog and orders, and escalates to your team when a human should step in.

SELL MORE
• Product recommendations render as rich cards with images, variants, prices, and one-click add-to-cart links
• The agent can build a checkout for the shopper and drop the link right in chat
• Guided flows collect preferences (budget, experience, style) and recommend the right product

SUPPORT BETTER
• "Where's my order?" — Janis verifies the customer with a one-time email code, then pulls live order status and tracking
• Returns and warranty requests run as guided, step-by-step flows — the agent gathers the details, confirms the order, and files the request
• Answers come from your knowledge base — store policies, FAQs, and content you teach it — and Janis tracks its own knowledge gaps so you always know what to teach next

STAY IN CONTROL
• Human takeover: monitor conversations live, reply as yourself, then hand the thread back to the agent
• A shared inbox across every channel: web chat, Facebook Messenger, Instagram, WhatsApp, and email
• Escalation alerts to email and Slack, with the agent learning from each handoff
• Full audit trail — every action the agent takes is logged and reviewable

Setup takes minutes: install the app, and Janis deploys a storefront chat agent trained on your catalog — no theme edits, no code.`);

await set('featureList.0.description', 'Answers shoppers instantly with live catalog and order data — product recommendations, order status, returns, and policy questions.');
await set('featureList.1.description', 'Human takeover and a shared inbox across web chat, Messenger, Instagram, WhatsApp, and email — jump in, then hand back to the agent.');
await set('featureList.2.description', 'Verifies customers before sharing order data, runs guided return and exchange flows, and tracks its own knowledge gaps.');

await set('demoUrl', 'https://app.janis.ai/chat/d7087183-2d86-43f3-bc70-ba24c18cf5a2/page?mode=full');

// support: prefer email
await page.locator('input[name=":r55:"][value="SUPPORT_EMAIL"]').check().catch(() => console.log('radio miss'));
await set('supportEmail', 'mike@janis.ai');
await set('privacyPolicyUrl', 'https://app.janis.ai/privacy');
await set('websiteUrl', 'https://app.janis.ai');
await set('documentationUrl', 'https://app.janis.ai/docs');
await set('pricingUrl', 'https://app.janis.ai/pricing');

await set('subtitle', 'AI sales & support agent for Shopify');
await set('titleTag', 'Janis — AI Agent for Shopify');
await set('metaDescription', 'Janis answers shoppers on your storefront — product recommendations, order lookups, returns — and hands off to your team when a human should step in. Live in minutes.');

await set('reviewNotificationEmail', 'mike@janis.ai');
await set('appSubmissionContactEmail', 'mike@janis.ai');

await set('testAccounts.0.username', 'michael.nathanson+shopify@gmail.com');
await set('testAccounts.0.password', 'Shopify7a-s2iy7en4');
await set('testAccounts.0.accountDescription', 'Admin on a demo workspace connected to a test store');
await set('screencastUrl', 'https://app.janis.ai/uploads/janis-shopify-demo.mp4');
await set('testingInstructions', `1. Sign in at https://app.janis.ai with the test account above — you land in the "SnowboardsAreUs" demo workspace, which is connected to a live test store.
2. The SnowboardsAreUs agent is already deployed on the store's chat bubble. Open a conversation in the Inbox to see real order lookups, product recommendations, and a completed return flow.
3. To test as a shopper, open the demo chat page (Demo store URL) and ask "I'm a beginner — what board do you recommend?" — the agent replies with a real product from the catalog.
4. To see human takeover: open any conversation in the Inbox, click "Take over", reply, then "Resume agent".
5. Installing on a dev store: click Install from the app listing — Janis provisions a workspace and deploys the storefront bubble automatically; no theme edits needed.`);

await page.screenshot({ path: `${OUT}/14-filled.png`, fullPage: true });
const saveBtn = page.locator('button:has-text("Save")').first();
console.log('save count:', await page.locator('button:has-text("Save")').count(), 'disabled:', await saveBtn.isDisabled().catch(() => '?'));
await saveBtn.click({ timeout: 10000 }).catch(async (e) => {
  console.log('save click failed:', e.message.slice(0, 100));
});
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/15-after-save.png`, fullPage: true });
await ctx.close();
console.log('done');
// note: save must happen in-session — appended save step
