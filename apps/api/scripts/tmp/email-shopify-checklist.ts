/** One-off: email Mike the Shopify launch checklist (his steps only).
 *  npx tsx scripts/tmp/email-shopify-checklist.ts — needs RESEND_API_KEY + JANIS_EMAIL_FROM. */
const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  body: JSON.stringify({
    from: process.env.JANIS_EMAIL_FROM,
    to: ['michael.nathanson@gmail.com'],
    subject: 'Janis on Shopify — your 7 dashboard steps to launch',
    headers: { 'X-Janis-Outbound': 'notify', 'Auto-Submitted': 'auto-generated' },
    text: `Everything on the code side is done and deployed (janis-api-00855-zvg): install, storefront chat, order/refund/catalog webhooks, billing rail, App Store config. What's left to get Janis live on the Shopify App Store is all in the dashboards — these are your steps, in order.

STEP 1 — Distribution → Public  (the gate for everything else; irreversible, and correct for us)
1. Open https://dev.shopify.com/dashboard/238766671/apps/430996553729
2. Home → Distribution card → "Select distribution method" → Public.
Without this, real merchants can't install, billing charges get rejected, and the App Store listing form stays locked.

STEP 2 — Partner profile + developer name
Partner Dashboard → Settings → Partner profile:
- Developer name: "Janis" — it currently shows "My Store" under the app name on the merchant install screen. If there's no rename field, this needs a Shopify support ticket or an org transfer.
- Support email: support@janis.ai
- Privacy policy URL: https://app.janis.ai/privacy

STEP 3 — App listing  (unlocks after Public)
Dev Dashboard → the app → "Manage Shopify App Store listing". Paste this:

  App name:  Janis — AI support agent for your store
  Tagline:   An AI teammate that answers shoppers, looks up orders, and sells in chat.

  Intro:
  Janis puts an AI support agent on your storefront in minutes. It knows your
  catalog and policies, answers order questions, creates draft orders shoppers
  can pay for right in chat, and hands off to your team when it should — not
  when a keyword trips.

  Key benefits:
  - Trained on your real store: catalog and shop policies sync automatically
    and stay fresh as products change.
  - Shoppers can ask "where's my order?", get status, and even buy — draft
    orders with a pay link, created in chat.
  - Human handoff built in: refunds, angry customers, and explicit requests
    go to your team in the Janis inbox with full context.
  - One-click theme app embed — the chat bubble goes live with zero theme edits.
  - Every agent reply is logged, reviewable, and testable before it ships.

  Pricing model (if asked):
  Monthly subscription via Shopify Billing — Starter $29/mo (2,000 messages),
  Pro $99/mo (20,000), Scale $299/mo (100,000). Usage beyond included messages
  bills per 1,000 on the same subscription.

STEP 4 — Screenshots  (1600x1200 min, PNG)
1. Storefront chat: shopper asks about a product → product card with price + image
2. Draft-order flow: "I want it" → created → pay link
3. Janis inbox: the same conversation with internal order notes
4. Agent editor: knowledge panel showing synced catalog + policies
5. Embedded app home inside Shopify admin

STEP 5 — Protected Customer Data declaration
The review form asks which protected data the app accesses and why. Honest answers: customer name/email (order lookups, draft orders, thread matching), address (arrives on checkout webhooks, not persisted), phone (shopper-requested self-service updates), order data (status answers, returns, refund alerts). Paste as the justification:

  Janis uses customer email and order identifiers only to answer the
  shopper's own questions in chat (order status, fulfillment), to create
  draft orders and return requests the shopper asked for, to update the
  shopper's own customer record on request, and to note checkout activity
  on an existing conversation thread. Customer data is never used for
  advertising, never shared with third parties, and is deleted on the
  GDPR redact webhooks (customers/redact, shop/redact) which we already
  handle.

STEP 6 — Demo video
Review requires a walkthrough: install → link an agent → storefront chat → order lookup → draft order → inbox handoff. A quick screen recording is fine.

STEP 7 — Submit for review.

— When you flip Public (step 1), tell me and I'll do my part: re-approve the dev-store install so the token picks up the bundled scopes (read_reports, write_returns, write_customers, write_discounts, read_checkouts), verify the billing rail end-to-end (billing/start → approve → plan flips), and run "shopify app deploy" if the config drifted. Billing test-mode is automatic now — dev stores get test charges, real installs get live charges, no flag to set.`,
  }),
});
console.log('email:', res.status, res.ok ? (await res.json() as { id: string }).id : await res.text());
process.exit(res.ok ? 0 : 1);
