# Janis reboot — agent notes

## Stack

npm workspaces monorepo: `apps/api` (Hono + Drizzle, PGlite dev / Postgres prod),
`apps/web` (React + Vite PWA), `packages/shared` (zod contracts), `packages/sdk`.

## Dev servers

- API: `npm run dev -w apps/api` → http://localhost:8787 (tsx watch)
- Web: `npm run dev -w apps/web` → http://localhost:5173 (vite, proxies /api + /auth)
- Login: `admin@janis.local` / `janis-admin` (env-overridable seed)
- Demo agent: `npm run demo-agent -w apps/api` (needs built packages/shared + sdk)

## Verify after every change

1. `npm run typecheck` (root — all workspaces)
2. `npm test -w apps/api` and `npm test -w apps/web`
3. `./scripts/smoke.sh` — checks web 200s, API health, login, all key endpoints,
   and that the SSE stream delivers a live event. Run this **before telling the
   user to reload the Devin preview** — it catches dead servers, CORS breaks,
   and endpoint regressions.

## Caveats

- SSE check needs an existing conversation to trigger a bus event.
- Slack features need SLACK_CLIENT_ID/SECRET/SIGNING_SECRET + a public API URL.
- Devin preview proxies :5173 — API CORS echoes localhost/127.0.0.1 origins.

## Gotchas
- Repo lives at ~/repos/janis (moved out of iCloud Drive — sync was corrupting
  files mid-edit). Do NOT run the API with .pglite inside a synced dir;
  apps/api/.env sets PGLITE_DIR=~/.janis/pglite.
- Only ONE tsx watch may run against a PGlite dir at a time; kill extras (pkill -f "tsx watch src/index.ts") before restarting.

## Billing / Stripe

- Plans live in apps/api/src/lib/plans.ts (base + included msgs + overage/1k; free hard-caps).
- apps/api/.env runs LIVE mode (sk_live + live price ids). Test-mode equivalents are kept alongside as `*_TEST` vars — swap them back for local billing work.
- Live webhook endpoint we_1UHwWgLuGzRk7fCQQpisSIEG → https://app.janis.ai/billing/stripe-webhook (created via API 2026-09; the old janis.ai endpoint was disabled and deleted). Test mode has its own endpoint at janis.ai. Local dev uses `stripe listen --api-key $STRIPE_SECRET_KEY_TEST --forward-to localhost:8787/billing/stripe-webhook` (the whsec it prints goes in STRIPE_WEBHOOK_SECRET_TEST).
- Customer Portal configured on both modes: card updates, invoice history, immediate cancel.
- Meters (both modes): janis.messages (1 per stored message) and janis.llm_micros (billed micro-USD incl. margin per LLM call). BYOK agents (config.llm.api_key or base_url set) record usage events at costMicros=0 — never metered. Metered prices live on dedicated products so checkout labels them separately from the plan: "Janis message usage" (prod_VKx9gGkJ… live / prod_VKxACS8m… test) — starter/pro/scale = live price_1UKHFn…uHJFhBB/…IT3YhTbM/…Sy5S2Qs, test price_1UKHFx…JcrUAy0/…LeDI4cMA/…Wibyvg6; "Janis AI usage" (prod_VKx2fsf… / prod_VKx2MIv…) — llm live price_1UKH8c…kxAw9lo, test price_1UKH8l…1V1LJs5. Existing subs keep the old-generation price ids on their items — builtinTools change_plan matches the overage item by meter id, not price id, so plan swaps stay correct across generations. Checkout adds the plan's metered price + LLM price as extra line items.
- .env edits do NOT trigger tsx watch reloads — restart the API after changing env.

## Deploy (Cloud Run)

`./scripts/deploy-gcp.sh` — Cloud Build → gcr.io/janis-prod-mn/janis-api → Cloud Run
service `janis-api` (us-east1), serving web+API same-origin at
https://janis-api-696050206949.us-east1.run.app. PGlite data persists on GCS
bucket janis-data-janis-prod-mn via FUSE mount at /app/data (demo-grade — use
DATABASE_URL + managed Postgres for real load; keep --max-instances 1 with
PGlite: single writer only).

Postgres cutover: provision Cloud SQL, run the auth proxy, rsync the bucket's
pglite dir, then `DATABASE_URL=… PGLITE_DIR=… npm run migrate-to-pg -w apps/api --
--apply` (idempotent — re-run to catch stragglers). Set DATABASE_URL in
apps/api/.env.production and redeploy — deploy-gcp.sh stores it in Secret
Manager and attaches the Cloud SQL connector when the URL uses a
/cloudsql/… host. --max-instances stays 1: voice bridge, Gmail poller and
sweeper are still in-process.

## Shared package

@janis/shared resolves to dist/ in all consumers (prod Node can't load .ts).
After editing packages/shared/src, run `npm run build -w packages/shared`
before typecheck/tests/dev.

## Open work — competitive gap tracker (updated 2026-10-01)

**Infra / reliability**
- Multi-instance: DONE — bus_events SSE relay, viewers + voice_queue tables,
  sweeper_locks leader election (sweeps, gmail poll, digests). Deploy raises
  --max-instances to 3 (MAX_INSTANCES env override) on DATABASE_URL mode.
- Hosted-voice compliance (partial): paid-plan gate (402 on free),
  VOICE_HOSTED_MAX per-workspace cap (default 3) and VOICE_PROVISION_DAILY
  attempt cap (default 10, counted from usage_events voice_provision rows).
  Still missing: regulatory address-bundle / toll-free verification flows
  for countries that need them (Twilio purchase errors surface in the UI).
- Gmail push: DONE — users.watch → Pub/Sub gmail-push → POST /gmail/push
  ?token= runs the per-channel poll near-real-time; sweeper renews watches
  (7-day expiry), 60s poll remains as fallback. Env: GMAIL_PUBSUB_TOPIC,
  GMAIL_PUSH_TOKEN. Infra: topic gmail-push + push sub gmail-push-sub →
  https://app.janis.ai/gmail/push, gmail-api-push@system.gserviceaccount.com
  has pubsub.publisher on the topic.

**Billing loose ends**
- janis.voice_micros: DONE — live meter mtr_61VUG0yQ3HYJYG4ZJ41LuGzRk7fCQCw4,
  product prod_VLZCJIrcFxAQCI, metered price price_1UKs3dLuGzRk7fCQ9FXCr3Jr
  ($0.000001/unit → micro-USD passthrough), STRIPE_METER_PRICE_VOICE in .env,
  added to checkout line items. NOTE: existing subscriptions predate the
  price — their voice usage records in usage_events but won't invoice until
  the item is added to the sub (Stripe API) or they re-checkout.
- Hosted voice bills Twilio cost × (1 + BILLING_MARGIN); VOICE_COST_MICROS_PER_MIN
  env overrides the $0.014/min default if Twilio rates change.

**Product depth (features exist, competitors go deeper)**
- Help center: no search, SEO metadata, custom domain, or widget link.
- Marketplace: webhook template + event export cover Zapier manually; no
  one-click OAuth app directory or published Zapier app.
- Intent classification: classifies first message only — no drift
  reclassification; no nightly eval scheduling or regression alerting.
- Eval suite: CSV import + A/B runs exist; no scheduled runs, history, or
  diff dashboards.

**Enterprise checklist (untouched — gates mid-market only)**
- SSO/SAML, SCIM, audit log, SOC 2, data residency.

**Done so far** (don't rebuild): voice (BYO + hosted via Twilio subaccounts),
CSAT on archive, Shopify/HubSpot/Zendesk/Stripe/Cal.com/iTunes/webhook tool
templates, operator metrics report, routing automations (keyword/inactivity/
auto_assign), Postgres cutover tooling (DATABASE_URL live in prod),
collision detection (presence + operator typing), public help center,
bulk eval CSV import + prompt A/B, URL knowledge sources with scheduled
re-crawl, intent classification + routing + Topics report, Zapier event
export + webhook tool template, voice usage metering, multi-instance (bus_events/viewers/voice_queue/
sweeper_locks, --max-instances 3), Gmail Pub/Sub push, hosted-voice plan
gate + provisioning caps, Stripe voice meter in checkout.
