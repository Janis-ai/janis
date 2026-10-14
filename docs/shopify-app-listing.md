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
- Create the new dev store under the new org (generated test data) and
  hand Devin its domain.

Devin's part once the new dev store exists:

- Reinstall on the NEW dev store → re-link the agent → verify storefront
  widget, webhooks, and a test charge end-to-end; update SHOP constants in
  the tmp battery scripts to the new dev-store domain.

Everything below applies to the NEW app once it exists.

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

**Pricing blurb (if asked to describe pricing model):**
Monthly subscription via Shopify Billing — Starter $29/mo (2,000 messages),
Pro $99/mo (20,000 messages), Scale $299/mo (100,000 messages). Usage beyond
included messages bills per 1,000 on the same subscription.

## 4. Screenshots to capture (1600×1200 min, PNG)

1. Storefront chat: a shopper asks about a product → agent renders a product
   card with price + image.
2. The draft-order flow: shopper says "I want it" → approval/created →
   pay link.
3. Janis inbox: the same conversation with internal order notes.
4. Agent editor: knowledge panel showing synced catalog + policies.
5. Embedded app home in Shopify admin (the link/activate screen).

## 5. Protected customer data (PCD) declaration

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

## 6. Review checklist (order of operations)

- [ ] Create the new **Janis** app, distribution **Public** (step 0 — gate
      for everything below); hand Devin the new client_id + API secret
- [ ] Partner profile: developer name, support email, privacy policy URL
- [x] Charge test mode — **automatic**: derived per-shop from
      `shop.plan.partnerDevelopment` (dev stores → test:true, real installs →
      live charges). No env flag to forget.
- [ ] Verify a real `appSubscriptionCreate` on the dev store (test:true
      auto-applies) → approve → `app_subscriptions/update`
      webhook flips `workspaces.plan` — billing rail proven end-to-end
- [ ] Re-approve the app in the dev store admin so the token picks up the
      bundled scopes — `read_legal_policies`, `write_returns`,
      `write_customers`, `write_discounts`, `read_checkouts` (janis-10) —
      one consent covers all five
- [ ] Screenshots (step 4)
- [ ] PCD declaration (step 5)
- [ ] Demo video — review requires a walkthrough: install → link agent →
      storefront chat → order lookup → draft order → inbox handoff
- [ ] App listing submitted for review
