# Shopify App Store — listing + review prep (Phase 6)

One-time dashboard steps Mike must take (can't be done from code/CLI):

## 0. Fresh app — REPLACES the old migrated app (decided 2026-10-14)

The migrated app (`430996553729`, client_id `cf22b09da8f49a7c7cdf7ff39b17fb87`)
came out of the Dev Dashboard migration without an explicit distribution flag
and `appSubscriptionCreate` fails on it. Rather than fight migration state,
we're creating a **new app, Public from the start** — still named "Janis".

Mike's part:

1. **New partner org** — the app must NOT live under "My Store" (org id
   238766671): orgs can't be renamed without a support ticket, and the org
   name shows as the developer name on the merchant install screen.
   partners.shopify.com → Organizations → **Create organization** → `Janis`.
2. Switch the Dev Dashboard to the new org → **Create app** → name `Janis`
   → distribution **Public** (if the creation flow doesn't offer a picker,
   set Home → Distribution → Public right after). No name collision — the
   old app lives in the other org.
3. **New dev store under the new org** — test installs are org-scoped, and
   the existing store belongs to "My Store". Partners → Stores → Add store →
   Development store → tick **"Start with generated test data"** — that IS
   our current catalog (the snowboard dataset is Shopify's standard fixture),
   so the widget battery transfers verbatim.
4. Hand Devin the new **client_id**, **API secret key**, and dev-store
   domain — or paste into `apps/api/.env.production` as
   `SHOPIFY_APP_API_KEY` / `SHOPIFY_APP_API_SECRET`.

Status 2026-10-14: DONE — new org "Janis" (240865640), app 435599310849,
client_id `bbc74ee5092894c6b45e93e24db1ede6`, version `janis-2` released
(435599310849/versions/1167529443329), API redeployed with new creds
(janis-api-00857-tfd).

Mike still needs to:

- Confirm **distribution = Public** on the new app — the creation flow
  showed no picker. Now that janis-2 is released, check
  https://dev.shopify.com/dashboard/240865640/apps/435599310849 → Home /
  left-nav Distribution → Public.

Status 2026-10-16: the dev-store question resolved itself — all 9 stores
in Partner Dashboard are already under the Janis org; the old org's only
store (janis-store-sx5bpcd3, frozen → deprecated-token warning source) is
deleted. Canonical test store = **snowboardsareus.myshopify.com** (zero-
login provisioned, linked, billing-verified). Blamp is the secondary.

Everything below applies to the NEW app.

## 2. Organization / partner profile

Partner Dashboard → Settings → Partner profile. The listing shows the
**developer name** — set it to `Janis` (or `Cognition AI, Inc.` if legal
entity naming is preferred) and the support email to `support@janis.ai`.
Public apps need a public-facing privacy policy URL + support contact —
`https://janis.ai/privacy` once the marketing site cutover lands (launch
backlog A1); `https://app.janis.ai/legal/privacy` works as a stopgap if that
page exists.

## 3. Listing copy (paste into the listing form)

**App name:** Janis — AI support agent for your store

**Tagline (80 chars max):**
An AI teammate that answers shoppers, looks up orders, and sells in chat.

**Intro (short description):**
Janis puts an AI support agent on your storefront in minutes. It knows your
catalog and policies, answers order questions, creates draft orders shoppers
can pay for right in chat, and hands off to your team when it should — not
when a keyword trips.

**Key benefits / features:**
- Trained on your real store: catalog and shop policies sync automatically
  and stay fresh as products change.
- Shoppers can ask "where's my order?", get status, and even buy — draft
  orders with a pay link, created in chat.
- Human handoff built in: refunds, angry customers, and explicit requests
  go to your team in the Janis inbox with full context.
- One-click theme app embed — the chat bubble goes live with zero theme edits.
- Every agent reply is logged, reviewable, and testable before it ships.
- Recovers abandoned carts two ways: a friendly chat follow-up while the
  shopper is still browsing, then an email sequence (1 hour / 1 day / 3
  days) with a link back to their saved checkout — recovered revenue is
  tracked right in the app.

**Pricing blurb (if asked to describe pricing model):**
Monthly subscription via Shopify Billing — Starter $29/mo (2,000 messages),
Pro $99/mo (20,000 messages), Scale $299/mo (100,000 messages). Usage beyond
included messages bills per 1,000 on the same subscription.

## 4. Merchant setup note — duplicate recovery emails

Janis's recovery sequence and Shopify's built-in abandoned-checkout email
(Settings → Checkout → "Abandoned checkout emails", or a Checkout/FLOW
automation) overlap: we can't detect whether the merchant has Shopify's
version on, and both will fire for the same shopper. Setup copy and the
Agent-tab toggle description should say: **use one or the other** —
ours is agent-voiced and references the chat they had; Shopify's is a
fixed template. Merchants keeping Shopify's can flip "Abandoned-cart
recovery emails" off in the Agent tab. Same for any Klaviyo/Mailchimp
abandoned-cart flow — ours should be disabled if one of those is live.

## 5. Screenshots to capture (1600×1200 min, PNG)

1. Storefront chat: a shopper asks about a product → agent renders a product
   card with price + image.
2. The draft-order flow: shopper says "I want it" → approval/created →
   pay link.
3. Janis inbox: the same conversation with internal order notes.
4. Agent editor: knowledge panel showing synced catalog + policies.
5. Embedded app home in Shopify admin (the link/activate screen).

## 6. Protected customer data (PCD) declaration

App Store review asks which protected data the app accesses and why. Our
honest answers, mapped to what the code actually does:

| Data type | Accessed | Justification |
|---|---|---|
| Customer name | yes (order + checkout payloads) | Match a shopper's question to their order/conversation |
| Customer email | yes | Order lookup + draft order creation + linking chat visitors to orders + checkout activity notes |
| Customer address | yes (checkout payloads only — not persisted) | Arrives on checkouts/update webhooks; we use only email/cart contents for the thread note |
| Customer phone | yes (customerUpdate self-service) | Shopper asks to update their own customer record — verified-order flow only |
| Order data | yes | Order status answers, fulfillment updates, return requests, refund alerts in the inbox |
| Product data | yes (not PCD) | Catalog sync — product info is not protected customer data |
| Shop policies | yes (not PCD) | Policy knowledge for agent answers |

Draft justification text for the form:
> Janis uses customer email and order identifiers only to answer the
> shopper's own questions in chat (order status, fulfillment), to create
> draft orders and return requests the shopper asked for, to update the
> shopper's own customer record on request, and to note checkout activity
> on an existing conversation thread. Customer data is never used for
> advertising, never shared with third parties, and is deleted on the
> GDPR redact webhooks (customers/redact, shop/redact) which we already
> handle.

## 7. Review checklist (order of operations)

- [x] Create the new **Janis** app, distribution **Public** — done (step 0);
      confirm the flag is set: dev.shopify.com/dashboard/240865640/apps/435599310849
- [ ] Partner profile: developer name, support email, privacy policy URL
- [x] Charge test mode — **automatic**: derived per-shop from
      `shop.plan.partnerDevelopment` (dev stores → test:true, real installs →
      live charges). No env flag to forget.
- [x] Billing rail proven end-to-end (2026-10-16, snowboardsareus):
      `appSubscriptionCreate` (test:true auto) → merchant approve →
      `app_subscriptions/update` webhook → `workspaces.plan` free→pro,
      `billing_provider=shopify`. On blamp the stray-sub guard correctly
      skipped the flip (workspace plan `internal`).
- [x] Bundled scopes live — blamp carries the full janis-10 set
      (`read_legal_policies`, `write_returns`, `write_customers`,
      `write_discounts`, `read_checkouts`); no re-approval needed
- [x] Screenshots (step 5) — all captured to docs/listing-assets/:
      storefront product cards, draft-order pay link, collect form,
      verification gate, launcher bubble, inbox thread w/ internal note,
      agent editor knowledge panel (Shopify-synced sources), embedded-app
      home in Shopify admin
- [ ] PCD declaration (step 6)
- [ ] Demo video — review requires a walkthrough: install → link agent →
      storefront chat → order lookup → draft order → inbox handoff
- [ ] App listing submitted for review
