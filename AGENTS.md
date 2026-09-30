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
- Agency rebilling (Stripe Connect): an agency workspace connects an Express account
  (POST /api/billing/connect → account link; account.updated webhook flips
  connect_charges_enabled), sets per-tier retail prices via PUT
  /api/billing/agency-pricing (floored at wholesale — retail < wholesale baseCents
  rejected; products/prices are created ON the connected account), and client
  workspaces (workspaces.parent_workspace_id set — /auth/workspaces client:true)
  check out as DIRECT CHARGES on the agency account with
  application_fee_percent = wholesale/retail (Janis's cut of each invoice).
  Child rows store connect_customer_id/connect_subscription_id; plan changes swap
  the price on the existing sub in place; customer.subscription.deleted scoped to
  a connect account frees the child (falls back to inheriting the parent's plan).
  Effective-plan rules: a child WITH connect_subscription_id has its own
  subscription (doesn't count toward parent agent limits); without it the child
  inherits the parent plan. Metered usage (messages/LLM/voice) reports to the
  AGENCY's platform customer via billingCustomerFor() — the agency pays Janis
  wholesale usage while invoicing their client retail. /billing/downgrade on a
  connect-billed child cancels on the agency's account. Tests:
  routes/billing.test.ts stubs Stripe (setStripeClient) end-to-end.
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
  UPDATE 2026-09-29: scanned all live subs — zero carry Janis prices or
  workspace_id metadata; no Janis subscriptions exist yet. Backfill is
  moot until the first real customer checks out.
- Hosted voice bills Twilio cost × (1 + BILLING_MARGIN); VOICE_COST_MICROS_PER_MIN
  env overrides the $0.014/min default if Twilio rates change.

**Channels (missing entirely)**
- Outlook/Office 365 mailbox channel (Graph API watch → same push plumbing as Gmail).
- SMS channel: DONE — `kind: 'sms'`, POST /sms/:channelId Twilio-signed inbound
  → handleChannelMessage (E.164 sender = binding key, MessageSid dedup),
  replies via Messages API (sendSmsReply in lib/channels.ts — >1600-char
  newline split, attachments → MMS, buttons → numbered list). MMS inbound
  rehosts through Twilio basic-auth creds (rehostAttachments basicAuth arg).
  Create: BYO sid/token/number or `from_voice_channel_id` (clones creds,
  setSmsWebhook auto-wires SmsUrl by number-SID lookup — hosted + BYO).
  Deleting a hosted voice channel cascades its SMS sibling.
- Shared email addresses: PARTIAL — answer_rules on every email channel
  (PATCH /api/channels/:id {email_filters, from_address, gmail_query}):
  answer_addresses allowlist (mail To/Cc/Delivered-To a listed address
  ingests even when list-fanned — fixes the Google-Group member case),
  list_mail opt-in, sender allow/block (@domain or address),
  subject_exclude substrings, send-as From override, gmail poll query
  scope. mailSkipReason() in lib/email.ts is the single decision point —
  gmail/outlook sweeps + Resend inbound all run it. Still missing: true
  multi-address fan-out (one channel per address today).
- First-class WhatsApp Business API channel: DONE templates for outbound
  (POST /api/channels/:id/send + /broadcast accept whatsapp_template
  {name,language,body_params}; required outside the 24h window — enforced on
  new threads). Still missing: template management/submission UI, business
  verification flow.
- Voice: voicemail routing, IVR ("press 1 for a human"), call-recording consent,
  call transcripts rendered in the transcript view.
- Widget polish: unread badges, proactive messages, file uploads, sound,
  per-agent branding, chat-on-article-page.

**Inbox & operator experience**
- Snooze: DONE — conversations.snoozed_until, hidden from every queue except
  the ?state=snoozed view, passive expiry, inbound customer message wakes it,
  excluded from attention-count. UI: detail-page 😴 select (1h/4h/tomorrow 9am/
  next week/unsnooze) + bulk action + 😴 chip on list rows.
- Internal notes: DONE — composer "🔒 internal note" mode → POST /:id/note,
  payload.internal=true, never customer-delivered, Slack-mirrored.
- Saved views: DONE — saved_views table (per-user), GET/POST/DELETE /api/views,
  filters blob mirrors list params; Views picker + "💾 Save view" in the list.
- Bulk actions: DONE — row checkboxes + select-all, sticky action bar →
  POST /api/conversations/bulk (archive/unarchive/assign/tag/mark/star/snooze).
- Contacts: DONE (v1) — contacts + contact_identities tables, conversations
  carry contact_id, lib/contacts.ts resolves (channel, platform_user_id) →
  contact with cross-channel merge on email/phone; GET/PATCH /api/contacts,
  POST /:id/merge, /contacts UI with dup detection, contact card on the
  conversation sidebar. Still missing: conversation merge/split, contact
  import, custom fields, company grouping.
- Webhook ops: DONE — deliveries list on the agent page (payload, attempts,
  next_attempt_at), POST /api/agents/:id/deliveries/:did/replay re-sends a
  failed delivery with a fresh signature + full retry budget.
- Status/monitoring: DONE (basic) — GET /status probes db + sweeper-leader
  liveness (503 when degraded), /status web page, sweepDeliveryFailures logs
  a `janis.alert` ERROR marker on webhook-failure spikes (attach a Cloud
  Logging log-based alert to it). Still missing: real SLO dashboards, uptime
  history, third-party status page.
- SLA timers + breach alerts (business-hours-aware).
- Mobile polish on conversation screen (operators live on phones).

**npm**
- `janis` (SDK): published — latest 1.0.1 (1.0.0 leaked @janis/shared type
  imports in .d.ts; 1.0.1 owns its wire types in src/types.ts). Granular
  token `devin-publish` bypasses 2FA for CI publishes.
- `janis-agent` (runnable template): published 1.0.0 — `npx janis-agent`
  quickstart now documented alongside docker; docs/console copy updated.

**Product depth (features exist, competitors go deeper)**
- Campaigns: v2 — campaigns + campaign_sends tables, /api/campaigns CRUD +
  preview + schedule + send-now, /campaigns UI, sweeper dispatch via jobs,
  opt-out suppression recorded as skipped_opted_out. Segments: q text match
  + has_email/has_phone/active_within_days/never_replied filters. Fan-out is
  crash-safe — unique (campaign, step, recipient) key resumes partial
  dispatches; 'sending' campaigns re-run dispatch each tick as gap-fill.
  Drip steps (campaigns.steps: [{delay_minutes, text, whatsapp_template?}])
  dispatch as campaign.step jobs, reaching prior-step sent + unreplied
  only. Reply attribution: campaign_sends.replied_at stamps on inbound in
  the send's conversation. Agent binding: campaign → channel → channel.agent_id;
  campaigns.agent_instructions is injected into the reply prompt (and
  suggestion prompt) for campaign-originated conversations via
  campaignContextFor — the agent knows it's answering a campaign reply and
  gets workspace-authored handling guidance. UI shows the reply agent in
  the channel picker + list rows. Missing: lists/tags/CSV-import audiences
  (segment is filter-only), branching steps, conversion attribution,
  frequency caps/quiet hours, bounce→suppression loop, channel-readiness
  gating.
- Help center: search/slugs/SEO meta/custom domain/widget link done; seeded
  13 articles on prod Demo Agent + Janis agent. Missing: full-text ranked
  search (tsvector — ILIKE only today), article view counts, helpfulness
  votes, zero-results search log (feeds content roadmap), version history,
  widget article embeds.
- Marketplace: webhook template + event export cover Zapier manually; no
  published Zapier app (listing/submission = highest-leverage non-code task),
  no one-click OAuth installs, no public /integrations directory, outbound
  webhooks are fire-and-forget (no retries/dead-letter/management UI).
- Intent classification: first-message only — no drift reclassification,
  confidence + manual override, sentiment, auto-topic clustering.
- Eval suite: CSV import + A/B runs exist; no scheduled runs, no regression
  alerting (pass-rate drop → Slack/email), no run history/diff dashboards,
  no multi-model compare, no auto-generated tests from rescued conversations.

**Outbound (new — v1 shipped)**
- POST /api/channels/:id/send {to,text,subject?,whatsapp_template?} — find-or-
  creates the conversation + binding, records the attempt (failure flag on
  provider rejection), resolves the contact. Members+ can send.
- POST /api/channels/:id/broadcast {recipients≤200,...} — admin only, 150ms
  spacing, per-recipient results.
- Initiatable kinds: sms, email, gmail, whatsapp (template required on new
  threads — 24h rule). Messenger/IG/webchat/voice reject outbound — Meta
  window rules + pull-based widget.
- Missing vs real campaign tools: no scheduling, drip sequences, opt-out
  management (STOP handling on inbound sms is still manual), audience
  segments, or per-campaign analytics.

**Billing (missing)**
- Trials + annual: CODE-COMPLETE — checkout supports trial_period_days +
  yearly price ids via STRIPE_PRICE_*_YEARLY / TRIAL_DAYS env; workspaces.trialed_at
  guards one-trial-per-workspace; trial_will_end webhook handled. Remaining:
  seat pricing, in-app usage dashboard, add-on SKUs.

**Reporting (missing)**
- Time-series charts (volume, FRT, resolution over time — all point-in-time
  today), AI-vs-human resolution split / deflection rate (core ROI metric),
  CSV export.

**Reliability & scale (missing — honest weak spots)**
- Observability: no tracing (OTel), no SLO dashboards, no status page, no
  5xx/latency alerting (Cloud Monitoring → Slack).
- Job queue: jobs table + enqueueJob/runJobs under sweeper leader lock.
  Job types: outbound.send (broadcast + campaign sends + drip steps),
  campaign.step (drip scheduling), knowledge.refresh (URL re-crawls —
  sweeper only enqueues + bumps next_fetch_at as a claim marker). Still
  inline: gmail/outlook poll + watch renewals, alert/sla/snooze sweeps.
- Migration journal gotcha: drizzle applies a migration only when its
  journal `when` exceeds the newest __drizzle_migrations.created_at —
  hand-set future `when` values (0063–0067 had 1790740000000+) silently
  skipped later real-timestamped migrations. migrateDb() rewrites the
  poisoned rows (exact-stamp list) before migrate(); keep journal `when`
  monotonic with real time when hand-writing migrations.
- Rate limiting: DONE core layer — in-memory per-IP ceilings on all webhook/
  read surfaces; Postgres-backed rate_limits table + dbRateLimit on money
  paths (login 10/min/IP, chat writes 600/hr/channel-token via
  CHAT_TOKEN_HOURLY_MAX, chat uploads 60/hr via CHAT_TOKEN_UPLOAD_HOURLY_MAX)
  — caps hold across instances and rotated IPs. Fails open on DB error.
  Spend circuit breaker: DONE — llmSpendOverCap sums rolling-24h
  llm_tokens cost per workspace; over LLM_DAILY_CAP_MICROS (default
  $25, 0 disables) replyAsHostedAgent + suggestion gen pause and
  escalate via handoff_request (deduped alert, customer gets handoff
  notice). BYOK rows cost 0 — never trip.
  Remaining: CAPTCHA on widget after N messages, blocklisting repeat
  offenders, per-plan cap tiers.
- Backup/restore runbook (Neon PITR exists — unrehearsed), load test (k6).

**Enterprise checklist**
- Audit log: DONE — audit_log table + audit() helper; instrumented on agent/
  channel create+delete, outbound send + broadcast, webhook replay, contact
  merge, member invite, workspace update, billing connect/pricing/checkout/
  downgrade. Admin reads via GET /api/workspace/audit-log + Settings card.
- SSO/SAML: DONE via WorkOS AuthKit (gated on WORKOS_CLIENT_ID/API_KEY).
  SCIM: code-complete — POST /workos/directory-events verifies the WorkOS
  HMAC signature (WORKOS_DIRECTORY_WEBHOOK_SECRET), maps directory →
  workspace via workspaces.config.workos_directory_id, provisions/removes
  memberships on dsync.user.* events. Untested against a real directory.
- RBAC: viewer role — memberships.role 'viewer' is GET-only via a write
  block in sessionAuth (allowlist: own /users/me, /push, /views). Role
  picker + invite role select in Settings.
- GDPR: GET /api/contacts/:id/export (full JSON bundle) + DELETE /:id
  (?mode=purge wipes transcripts; default keeps anonymized shells).
  Both admin-only + audited.
- Still untouched: SOC 2 process, data residency, RBAC granularity beyond
  admin/member/viewer.

**Marketing surface (missing)**
- GA4 is live (G-G5W5H3CVR2) but no funnel events fire — instrument signup,
  first_agent, first_conversation, channel_connected.
- Public API/SDK docs, onboarding checklist (connect channel → test → invite),
  security/trust page, pricing/comparison pages.

**Done so far** (don't rebuild): voice (BYO + hosted via Twilio subaccounts),
CSAT on archive, Shopify/HubSpot/Zendesk/Stripe/Cal.com/iTunes/webhook tool
templates, operator metrics report, routing automations (keyword/inactivity/
auto_assign), Postgres cutover tooling (DATABASE_URL live in prod),
collision detection (presence + operator typing), public help center,
bulk eval CSV import + prompt A/B, URL knowledge sources with scheduled
re-crawl, intent classification + routing + Topics report, Zapier event
export + webhook tool template, voice usage metering, multi-instance (bus_events/viewers/voice_queue/
sweeper_locks, --max-instances 3), Gmail Pub/Sub push, hosted-voice plan
gate + provisioning caps, Stripe voice meter in checkout, email answer rules + send-as
(from_address, answer_addresses, list_mail, sender rules, gmail_query;
 List-Id group-mail fix), contacts spine +
merge UI, webhook replay/DLQ UI, /status probe, audit log, outbound send +
broadcast, campaigns v1, STOP opt-out, jobs queue, trials + annual billing,
WorkOS SSO + Outlook channel (both behind env creds).
