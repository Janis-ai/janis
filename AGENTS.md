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
- Only ONE tsx watch may run against a PGlite dir at a time; kill extras (pkill -f "tsx watch src/index.ts") before restarting. Boot-time self-heal: createDb probes `select 1` and, when the dir's postmaster.pid holder is dead, quarantines a wedged dir to pglite.broken-<ts> and reopens fresh (corrupt dir → new seed, no boot loop). A LIVE holder still fails loudly — don't run two watchers.

## Billing / Stripe

- Plans live in apps/api/src/lib/plans.ts (base + included msgs + overage/1k; free hard-caps).
- apps/api/.env runs LIVE mode (sk_live + live price ids). Test-mode equivalents are kept alongside as `*_TEST` vars — swap them back for local billing work.
- Live webhook endpoint we_1UHwWgLuGzRk7fCQQpisSIEG → https://app.janis.ai/billing/stripe-webhook (created via API 2026-09; the old janis.ai endpoint was disabled and deleted). Test mode has its own endpoint at janis.ai. Local dev uses `stripe listen --api-key $STRIPE_SECRET_KEY_TEST --forward-to localhost:8787/billing/stripe-webhook` (the whsec it prints goes in STRIPE_WEBHOOK_SECRET_TEST).
- Customer Portal configured on both modes: card updates, invoice history, immediate cancel.
- Customer-record tool security: ToolDef.identity binds catalog reads/writes
  (Stripe customer/charges/subs, Shopify order+customer orders, HubSpot
  get/search/update, Zendesk searches, Salesforce find/query, Cal.com list)
  to the conversation's VERIFIED identity — verified emails come only from
  sign-in (identity_verified/external_id) or mailbox-channel senders;
  provider ids must have been produced by an earlier tool result in the run.
  Signed-in workspace members count as operators (unbound). toolsFor
  backfills the flag onto configs installed before it existed.
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
/cloudsql/… host.

Prod migrations run PRE-DEPLOY, not at boot: deploy-gcp.sh executes
`npm run db:migrate -w apps/api` (scripts/migrate.ts — raw DATABASE_URL, same
journal-poison fix as migrateDb) inside the build env before updating the
service, then ships SKIP_DB_MIGRATE=1 so instances boot instantly without
racing the migrator behind the startup probe. A failed migrate aborts the
deploy. Dev (no SKIP_DB_MIGRATE) still migrates at boot; tests call
migrateDb directly.

## Shared package

@janis/shared resolves to dist/ in all consumers (prod Node can't load .ts).
After editing packages/shared/src, run `npm run build -w packages/shared`
before typecheck/tests/dev.

## Open work — competitive gap tracker (updated 2026-10-01)

**Launch backlog — consolidated plan index (the canonical list; detailed
implementation notes live in the sections below)**

*A. External gates — manual, clock-bound (Mike's track; every day delayed
is a day on launch)*
1. `www.janis.ai` cutover — the hard campaign gate. Cloud Run domain
   mapping, OAuth redirect re-registration (Google/Slack/Meta consoles),
   Stripe webhook re-registration, DNS, CORS tighten, cookie flags. Old
   app stays up for legacy clients.
2. Verify + export the 17k legacy list (Mongo export) — campaign prep is
   fiction without it.
3. IG App Review — submit `instagram_manage_messages` screencast +
   business verification (scope already declared in meta.ts).
4. Zapier publishing tail — toggle existing Zaps off/on (old polling
   triggers → REST hooks now), 2 more users via Sharing-tab invite, ToS
   checkbox.
5. Twilio — paid account, A2P 10DLC brand + campaign registration, non-US
   regulatory bundles.
6. Azure app registration → `MS_*` envs (unblocks Outlook — code DONE).
7. WorkOS account → SSO/SCIM (code DONE, env-gated).
8. Stripe yearly Prices (live+test) → `STRIPE_*_YEARLY` + `TRIAL_DAYS`
   envs (checkout code DONE).
9. `JANIS_SEARCH_API_KEY` — platform web-search tool key (unset, dead).

*B. Quick wins — ALL DONE or moot* (10 plan-meter + /billing/status ✓,
11 Agents View/Manage ✓, 12 per-event notify prefs grid ✓, 13 DB_POOL_MAX
✓, 14 JOB_CONCURRENCY ✓, 15 migrate-as-pre-deploy-step ✓, 16 .env.example
full pass ✓, 17 dep cleanup — @esbuild-kit/glob are transitive via
drizzle-kit/workbox-build, nothing to drop directly).

*C. Medium features (~1 session each)*
18. Discovery cards → Ask Janis — railBus.seed, ?rail=ask&q= deeplink,
    concierge knowledge CTAs, card-click tracking (needs 22).
19. Language Model tab — provider cards (platform/OpenAI/Gemini/custom),
    BYOK base_url-without-key guard.
20. Editor reorg remainder — Branding tab (agent-level webchat
    meta.branding editor + mock preview), finish knowledge split.
21. Webhook recipes in Docs — ManyChat/GHL HTTP-Request → POST /v1/events
    handoff recipe.
22. `analytics_events` + POST /api/track — in-product activation events
    (GA4 covers the funnel; this feeds 18's click tracking).
23. DONE — in-process state audit closed (convLock advisory lock, voice
    queue table, Meta OAuth stateless; remaining Maps are caches).

*D. Ops/reliability — needs console access or ceremony*
24. Neon PITR rehearsal — runbook below, unrehearsed.
25. k6 load test run + documented ceiling — scripts/load-test.js exists.
26. DONE — Cloud Monitoring → Slack live (status/monitoring below).

*E. Product depth tail (pull by customer demand)*
27. Eval tail — missing: run-diff dashboards, multi-model compare.
    (Scheduled runs, regression alerts, history, rescue→test suggestions
    all DONE — closest-to-done differentiator.)
28. Intent tail — sentiment, auto-topic clustering, confidence scores.
29. Help center tail — version history, widget article embeds.
30. Rate-limit tail — widget CAPTCHA after N, blocklist, per-plan tiers.
31. Channels tail — shared-email multi-address fan-out (answer_rules
    PARTIAL), WhatsApp template manager UI + business verification,
    voicemail/IVR/recording consent/transcripts, Outlook (blocked on A6).
32. Autonomous agent-led campaigns — rails exist (send policy, drip
    conditions, conversion attribution); last.

*F. Writing/marketing (non-code)*
33. Reactivation email sequence — 3 emails (approvals-led), subjects/
    preview/CTA → app.janis.ai.
34. docs/marketing/reactivation/RUNBOOK.md exists — verify against the
    checklist (export steps, send tool, UTMs, community posts,
    import-legacy workflow, metrics).
35. Agency economics decision — "what does my 12th client cost?"
36. Proof assets — 2–3 testimonials, logo wall, vs-Chatbase/Intercom
    comparison pages, trust/security page.
37. `/for/:slug` landing variants — copy written; ship when campaign
    data shows platform skew.

*G. Gated/deferred (correctly parked)*
38. Per-agent member scope — agent_members scoping/'hidden' role exists;
    full enforcement audit on first real agency ask.
39. drizzle-orm →1.0 when final.
40. Campaign holdout groups — on customer ask.
41. Enterprise — SOC 2 (Vanta/Drata), data residency, RBAC granularity
    beyond admin/member/viewer. (SSO/SCIM code-complete, GDPR
    export/delete DONE.)

*Loose ends*
42. `janis-zapier-logo.png` shows deleted in git — confirm intentional.
43. Three `big-j*.png` untracked in apps/web/public/img/ — commit or gitignore?
44. Optional: zapier-platform-core 19 bump before directory submission.

**Infra / reliability**
- Multi-instance: DONE — bus_events SSE relay, viewers + voice_queue tables,
  sweeper_locks leader election (sweeps, gmail poll, digests). Deploy raises
  --max-instances to 3 (MAX_INSTANCES env override) on DATABASE_URL mode.
  In-process-state audit (2026-10): convRuns guarded by a Postgres advisory
  lock (convLock.ts), voice replies pull from voice_queue, Slack dedup is
  DB-backed (payload->>slack_ts) with an in-memory fast path only; remaining
  module Maps are caches or cosmetic (typing bubble, thread status).
- Scale tail (2026-10): DB pool explicit — DB_POOL_MAX (default 8) sizes the
  postgres-js pool per instance (≤24 conns at 3 instances vs Neon pooler
  budget); job runner claims all due rows then runs handlers JOB_CONCURRENCY
  (8)-wide under the sweeper leader lock (claim-first unchanged — crash
  leaves 'running', reclaimed at attempts<5/5min stale); migrations moved to
  a pre-deploy step (see Deploy). In-process state audit: safe — TTL caches
  (cap/token/avatar/greeting/sub), slack channel+thread-status caches
  (lazy-refill), typing-relay dedup. convRuns run-guard CLOSED via
  lib/convLock.ts — pg session advisory lock per conv on a reserved
  connection + newestInboundIsPending makes lock-waiters no-op instead of
  double-replying (PGlite skips; single instance). Meta OAuth state CLOSED —
  no `pending` map: meta_connections stores the token before the picker
  opens, /pending + /link re-discover assets per request (connect_id is now
  a wire-contract marker, not a lookup key); data-deletion codes are
  HMAC-signed stateless instead of a Map. Voice bridge has no module
  state — queue lives in voice_queue.
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
- janis.stt_micros: DONE — widget dictation (POST /chat/:token/transcribe)
  meters per-transcription seconds × 50µ/s cost ($0.003/min) × margin to
  Stripe via recordSttUsage. Live meter mtr_61VVCEyYCM6z1OPzz41LuGzRk7fCQ8rI,
  product prod_VMXMb0XpGR8CVq, price price_1ULoHkLuGzRk7fCQ129lzSUk; test
  meter mtr_test_61VVCFE4MO5QgSemY41LuGzRk7fCQEW8, price
  price_1ULoHtLuGzRk7fCQDfNvk73L. STRIPE_METER_PRICE_STT(+_TEST) in .env,
  checkout adds it as a line item. Dictation is OPT-IN per webchat channel
  (credentials.dictation, Channels → appearance toggle) because it always
  runs on platform keys and bills even BYOK workspaces; internal channels
  (Ask Janis rail, test chat) bypass the flag. Widget + rail hide the mic
  unless the bootstrap emits dictation:true; the endpoint 403s when off.

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
- Auto-DNS setup: POST /api/channels/:id/email-domain/dns-setup picks the
  best path — Domain Connect (signed apply URL, zero-auth; dormant until the
  janis.ai/email-domain template merges into Domain-Connect/Templates and
  DC_PRIVATE_KEY is set — pubkey lives at _dc.janis.ai) → Cloudflare OAuth
  (client ac3f399e…, public+verified, refresh token stored per channel) →
  manual records table. Cloudflare OAuth callback: GET
  /channels/email-domain/cf-callback (HMAC state binds channel+workspace).
- Custom sending domains: DONE — client registers their domain on the
  channel's Custom sending domain card (POST /api/channels/:id/email-domain
  → Resend domains.create → records shown; /verify polls; DELETE cleans
  up). Verified domains unlock from_address on them; sends always set
  Reply-To to the channel's inbound_address so branded From never breaks
  routing. mailSkipReason also skips mail FROM emailInboundDomain — don't
  send test mail From @inbound.janis.ai, it self-skips by design.
- First-class WhatsApp Business API channel: DONE templates for outbound
  (POST /api/channels/:id/send + /broadcast accept whatsapp_template
  {name,language,body_params}; required outside the 24h window — enforced on
  new threads). Still missing: template management/submission UI, business
  verification flow.
- Voice: voicemail routing, IVR ("press 1 for a human"), call-recording consent,
  call transcripts rendered in the transcript view.
- Widget polish: unread badges, proactive messages, file uploads, sound,
  per-agent branding, chat-on-article-page.
- Custom Reply-To display address (TODO): email replies carry the
  per-conversation reply_address (conv-…@inbound.janis.ai) as From+Reply-To
  so replies route. Operators who forward their own mailbox into Janis
  don't want clients seeing that address — let the channel set a friendly
  Reply-To (e.g. their real support@). Caveat: replies to it only route if
  that address itself forwards into Janis (the forwarding setup already
  does), and reply-binding must then rely on In-Reply-To/References
  threading + sender match rather than the unique local part.

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
  conversation sidebar. Filtering + lists DONE: GET /api/contacts accepts
  segment params (q/tag/channel_id/list_id/has_email/has_phone/
  active_within_days/never_replied) via the shared segmentConditions in
  lib/campaigns.ts; contact_lists.filter jsonb = smart list (rules resolved
  at query time, self-updating — contact_list_members unused; list_id in a
  segment expands smart rules, depth-capped at 2); POST /api/lists accepts
  {filter} smart or {filter, snapshot:true} frozen; campaigns' seg.list_id
  picks up smart lists automatically. TODO — smart-list materialisation:
  lists resolve at query time today and contact_list_members sits idle; if
  list-indexed queries get hot or members need per-member state, the
  upgrade is materialising smart rules into members + a sweeper re-sync.
  Still missing: conversation merge/split, custom fields, company grouping.
- Webhook ops: DONE — deliveries list on the agent page (payload, attempts,
  next_attempt_at), POST /api/agents/:id/deliveries/:did/replay re-sends a
  failed delivery with a fresh signature + full retry budget.
- Status/monitoring: DONE — GET /status probes db + sweeper-leader liveness
  (503 when degraded), /status web page, `janis.alert` ERROR markers
  (webhook_delivery_spike sweep, eval_regression), and alerting is LIVE:
  opsAlert() posts to ALERT_SLACK_WEBHOOK at each marker, and Cloud
  Monitoring policy "janis-api errors to Slack" (severity>=ERROR on the
  cloud_run_revision, 5-min notify rate limit) pushes incidents through a
  webhook_tokenauth channel to POST /ops/alert → reposted to Slack. Note:
  Cloud Run strips the Authorization header at the IAM layer, so the
  channel URL carries ?token= instead of header auth (OPS_ALERT_TOKEN).
  Still missing: real SLO dashboards, uptime history, third-party status
  page.
- SLA timers + breach alerts (business-hours-aware).
- Mobile polish on conversation screen (operators live on phones).

**UX polish (2026-09 review — interaction layer good; reads engineer-polished)**
- A. Iconography: DONE — lucide-react nav icons (collapsed-rail legible) +
  star/snooze/save/paperclip chrome; emoji kept inside <option> text and
  emoji pickers (native elements can't render SVG).
- B. Shared usePrompt modal: DONE — workspace create, view naming, bulk
  tag, workspace-delete confirm all off window.prompt.
- C. Keyboard layer: DONE — ⌘K palette (nav + agents + conversation
  search, arrow-nav) app-wide; inbox triage keys j/k/Enter/e/s/u/x with
  focus ring + scrollIntoView.
- D. "Why" affordances: DONE — deferred sends stamp 'held — paused/quiet
  hours' on the send row (self-clears on real outcome); human status labels
  in the campaign detail; policy card explains defer-vs-drop.
- E. Operator docs: DONE — /docs?guide=operator tab (OperatorDocs.tsx)
  covering inbox states/takeover, keyboard map, handoffs+approvals, Slack
  thread takeover, campaigns+step conditions+enroll token, send-status
  table, suppressions, CRM sync/write-back, reports/exports, widget
  continuity. Sidebar "Operator guide" link; footer link renamed Docs.
- F. Accessibility sweep: DONE — global :focus-visible ring (inputs keep
  border-color), skip-link to #main-content, nav/main landmark labels,
  aria-modal+labelledby on Prompt/CommandPalette dialogs, aria-label on
  every icon-only button (was title=-only).
- Deferred: light mode; extended onboarding (checklist ends at first
  takeover — docs cover discovery more durably).

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
  Drip steps (campaigns.steps: [{delay_minutes, text, condition?,
  whatsapp_template?}]) dispatch as campaign.step jobs; step.condition
  branches on the prior step's outcome — if_not_replied (default),
  if_replied, if_converted, if_not_converted, always; the straggler
  re-check mirrors the condition so late qualifiers are never dropped.
  Reply attribution: campaign_sends.replied_at stamps on inbound in
  the send's conversation. Agent binding: campaign → channel → channel.agent_id;
  campaigns.agent_instructions is injected into the reply prompt (and
  suggestion prompt) for campaign-originated conversations via
  campaignContextFor — the agent knows it's answering a campaign reply and
  gets workspace-authored handling guidance. UI shows the reply agent in
  the channel picker + list rows.
  Audiences v2: contact-based targeting — email-kind channels reach
  email/alt_emails, phone-kinds reach phone/alt_phones (channel identities
  only gate opt-out, so imported contacts are targetable). contact_lists +
  contact_list_members + contacts.tags; /api/lists CRUD + member add/remove
  + POST /lists/import (CSV → upsertContactByAddress: match primary/alt
  email/phone, enrich don't duplicate). /contacts has People|Lists tabs —
  list index w/ counts, create/delete (contacts survive), member view w/
  search-to-add + remove. contacts.external_ids {system:id}
  keeps CRM/event identities on one Janis contact. campaigns.enrollment:
  'once' resolves+finishes; 'continuous' stays 'sending' — sweeper
  re-resolves each tick (unique send key dedupes). Drip delay is
  per-recipient (prior sentAt+delay); step jobs roll while stragglers
  exist. POST /enroll/:token = public event-enroll webhook (per-IP +
  per-token caps, only 'sending' campaigns accept enrolls). Send policy:
  lib/sendPolicy.ts checked inside outbound.send jobs — suppressions table
  (workspace,address,kind; bounce/complaint/dead_number/manual reasons),
  workspaces.config.send_policy {quiet_enabled,quiet_from,quiet_to,quiet_tz,
  max_per_recipient_per_day} via PATCH /api/workspace + Settings card,
  campaigns.send_cap total-send ceiling, pause/resume/cancel are lazy —
  queued jobs re-check campaign status + policy at send time (paused
  defers 15m, cancelled stamps skipped_cancelled, quiet hours defer to
  window end). /api/suppressions CRUD (admin).
  Deliverability loop: POST /channels/email/events handles Resend
  email.bounced/complained/failed (same Svix secret as inbound) → suppresses
  in every workspace owning that contact; sendSms sends StatusCallback →
  POST /sms/:id/status (Twilio-signed) → failed/undelivered writes
  dead_number suppression + flips the recent 'sent' campaign_send. Channel
  readiness: POST /api/campaigns/:id/send returns {queued, warnings} via
  lib/deliverability.channelReadiness — A2P brand check (messaging.twilio.com
  /v1/BrandRegistrations), Resend domain verify, Gmail/Outlook bulk caps,
  shared-domain volume warning. UI shows warnings on dispatch.
  Conversion API: POST /events/:token (workspaces.config.event_token,
  mint/rotate at POST /api/workspace/event-token, Settings card) →
  upsertContactByAddress → conversion_events row + last-touch attribution
  to the contact's freshest 'sent' campaign_send (stamps converted_at);
  campaigns.goal field, stats gain converted, form takes goal event name.
  Missing: branching steps, per-recipient timezone.
  GOTCHA: db.execute(sql`... returning *`) yields snake_case keys —
  workspaceId etc. are undefined; re-select through drizzle (jobs.ts does).
  That latent bug dead-queued every outbound.send until 0072.
- CRM sync: DONE (HubSpot v1) — crm_connections (workspace-scoped,
  encryptSecret'd token, list_id, lastmodified watermark, synced_count,
  last_error); /api/crm GET/POST/DELETE + /:id/sync-now (admin, Settings
  card probes the token before storing); 'crm.sync' self-rescheduling job
  (15min) → HubSpot contacts.search filtered lastmodifieddate>watermark,
  20-page cap/run → upsertContactByAddress anchored on external_ids.hubspot
  → stable 'hubspot sync' list; hs_email_optout → one-way suppression
  (never clears Janis opt-outs). Activity write-back: DONE (HubSpot notes) —
  connections gain activity_writeback flag (PATCH /api/crm/:id, Settings
  checkbox); every campaign send/fail/reply, conversion, human reply and
  SMS opt-out calls queueCrmActivity → crm_activity_queue (unique
  contact+kind+ref → dedup-safe) → 'crm.writeback' self-rescheduling job
  posts HubSpot notes (associationTypeId 202) onto the external_ids-anchored
  contact. Never creates CRM contacts; Janis-only contacts' rows drop on
  drain. Dead-letters after 5 attempts.
  Salesforce: DONE — provider dispatch in lib/crm.ts (applyChanged shared
  tail: upsert on external_ids anchor → provider-named sync list → one-way
  opt-out suppression). Connect via POST /api/crm {provider:'salesforce',
  host(*.my.salesforce.com), client_id, client_secret} — connected-app
  client_credentials, login probed before storing. Sync = SOQL Contact
  WHERE LastModifiedDate > wm ORDER BY ASC (nextRecordsUrl pages);
  HasOptedOutOfEmail → suppression. Write-back = completed Task (WhoId,
  Subject/Description) — SF auth minted once per batch, not per row.
  Still pending: full bidirectional field sync (later, separate product).
- Help center: search/slugs/SEO meta/custom domain/widget link done; seeded
  13 articles on prod Demo Agent + Janis agent. Ranked tsvector search
  (websearch_to_tsquery + ILIKE fallback), view counts, zero-result search
  log → GET /api/articles/insights (mig 0076), and helpfulness votes
  (help_votes table mig 0080 — POST /api/help/:agent/:article/vote,
  fingerprint-deduped + flippable; Insights card on the agent Help tab
  surfaces satisfaction %, downvoted articles, zero-result queries) all DONE.
  Missing: version history, widget article embeds.
- Marketplace: webhook template + event export cover Zapier manually; no
  published Zapier app (listing/submission = highest-leverage non-code task),
  no one-click OAuth installs, no public /integrations directory. Outbound
  webhooks have retries + deliveries/replay UI (DONE — see Webhook ops).
- Intent classification: drift DONE — classifyAndRoute stamps
  intent_source ('ai'/'byo'); recheckIntent re-classifies the last 4
  inbounds on later inbounds (≤1/15min per conv), a differing non-'other'
  label updates intent + re-fires that intent's rule tags (assign never
  steals). PATCH /conversations/:id {intent} = manual override, locks
  against drift; sidebar Intent card edits it ('· manual' marker).
  Still missing: sentiment, auto-topic clustering, confidence scores.
- Eval suite: CSV import + A/B runs + scheduled runs + regression alerting +
  run history DONE — agent_test_runs batches every execution (manual/ab/
  scheduled); config.eval_interval_hours + sweepEvals enqueue eval.run jobs
  (leader-locked, per-agent dedup, run_at heartbeat vs the 5min reclaim);
  detectRegression alerts on pass→fail flips, ≥20pp pass-rate drops, or an
  unrunnable suite via notifyWorkspace + janis.alert log (adjacent-batch
  compare — steady-state red doesn't re-alert). GET /agents/:id/test-runs +
  history/Auto-run UI on the tests tab, 'eval' SSE event refreshes it.
  Missing: diff dashboards beyond batch views, multi-model compare.
  Suggestions: DONE — GET /agents/:id/test-suggestions scans 30d of convs
  for rescue markers (failure/help/custom_alert flags, non-internal human
  replies) with no saved test; Tests-tab card → "Save as tests" (checkpoint
  split) or dismiss (config.dismissed_test_suggestions).

**Outbound (new — v1 shipped)**
- POST /api/channels/:id/send {to,text,subject?,whatsapp_template?} — find-or-
  creates the conversation + binding, records the attempt (failure flag on
  provider rejection), resolves the contact. Members+ can send.
- POST /api/channels/:id/broadcast {recipients≤200,...} — admin only, 150ms
  spacing, per-recipient results.
- Initiatable kinds: sms, email, gmail, whatsapp (template required on new
  threads — 24h rule). Messenger/IG/webchat/voice reject outbound — Meta
  window rules + pull-based widget.
- Ad-hoc send/broadcast only — scheduling, drips, opt-out suppression, and
  audience segments all live in campaigns (above). Inbound SMS STOP/START is
  automatic (lib/optout.ts: CTIA keywords set identity.opted_out_at, audited,
  no agent dispatch).

**Billing (missing)**
- Trials + annual: CODE-COMPLETE — checkout supports trial_period_days +
  yearly price ids via STRIPE_PRICE_*_YEARLY / TRIAL_DAYS env; workspaces.trialed_at
  guards one-trial-per-workspace; trial_will_end webhook handled. Remaining:
  seat pricing, in-app usage dashboard, add-on SKUs.

**Reporting**
- Containment/deflection: DONE — /api/reports/containment (contained vs
  escalated vs no-reply + daily series + approval/handoff timings) is the
  AI-vs-human split. Also live: /handoffs, /csat, /intents, /operators,
  /volume (daily convs + messages by direction — bar chart on Reports),
  /timeline (opened/FRT/resolution daily series + ai-vs-human resolved
  split — "deflection" card on Reports), /usage (messages vs plan
  included + LLM cost/tokens + voice seconds, current vs previous period — card on Reports), /export?kind=
  conversations|campaign_sends (CSV, scope-filtered, 5k-row cap).
- /timeline DONE — daily opened/FRT/resolution + ai-vs-human resolved
  split (deflection card). Reporting tail closed.

**Reliability & scale (missing — honest weak spots)**
- Observability: no tracing (OTel), no SLO dashboards, no
  5xx/latency alerting (Cloud Monitoring → Slack). /status probe + page done.
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
- Reply-claim verifier: DONE for action claims — hostedAgent checks each
  reply for "I've set your plan…" / "your refund was processed" / "will
  take effect" phrasing; with zero backed tool calls the draft regenerates
  once with feedback, and a surviving claim gets its sentences stripped
  (inspector flags claim_guard). Tap markers (payload.tap/tap_of via the
  janis:sel: postback/list-id marker and webchat tap fields) annotate taps
  in the transcript so a pick can't read as a typed command — the incident
  that prompted this: a "Choose Free" card tap produced a fabricated
  plan switch + invented workspace name. DONE for component claims too —
  claimsWidgetShown ("here are the cards…") with zero emitted widgets and
  deniesWidgetShown ("the buttons didn't render") with emitted ones both
  regen once then strip (inspector flags widget_guard). Component nouns
  only — bare "options"/"list" also mean text choices.
- Load test: scripts/load-test.js (k6) — staged 10→150 RPS on health +
  session-auth'd reads, p95<800ms / <1% errors thresholds; run against a
  preview revision, never prod at 150rps without warning. Read-only by
  design (writes pollute CRM write-back + billing meters).
- Backup/restore runbook (Neon PITR exists — unrehearsed): rehearsal = Neon
  console → Branches → new branch "from a point in time" → psql into the
  branch endpoint, verify a known row (e.g. newest campaign_send) → delete
  branch. For real restores prefer branching + cutover over overwriting the
  primary branch.
- Cloud Monitoring alerts: scripts/setup-alerts.sh (CLI-able, needs
  ALERT_SLACK_WEBHOOK) — Slack webhook channel + log-based janis_api_5xx
  metric (>5/min for 60s) + run.googleapis p95>3s/5m policy. Run once with
  gcloud auth'd to janis-prod-mn; janis.alert ERROR markers remain as an
  extra anchor for log-based alerts.

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

**Env / provider / stack gaps (audited 2026-09-30)**
- Prod env = .env overlaid by .env.production (deploy-gcp.sh merges →
  /tmp/janis-env.yaml; DATABASE_URL/TWILIO_AUTH_TOKEN also via Secret Manager).
- Dead everywhere (missing from BOTH envs): MS_CLIENT_ID/SECRET/TENANT/
  PUSH_TOKEN (Outlook channel code-complete, needs Azure app reg),
  WORKOS_* ×4 (SSO/SCIM need a WorkOS account), STRIPE_PRICE_*_YEARLY +
  TRIAL_DAYS (yearly Prices don't exist in Stripe yet — create live+test),
  RESEND_INBOUND_SECRET (inbound-mail auth unset on the shared domain),
  JANIS_SEARCH_API_KEY (agent web-search tool dead).
- Missing locally only (set in .env.production): SLACK_SIGNING_SECRET(+ALT),
  JANIS_SECRETS_KEY (falls back to sha256(SESSION_SECRET) — fine, but
  prod-encrypted secrets can't decrypt locally regardless).
- Twilio provider-side (can't fix in code): paid-account status, A2P 10DLC
  brand+campaign registration — hard blocker for bulk US SMS, regulatory
  address bundles for non-US voice.
- LLM config OK locally (JANIS_LLM_* on gemini, OPENAI+ANTHROPIC keys set);
  JANIS_LLM_PROVIDERS multi-provider map + LLM_PRICES unset (optional).
- Stack upgrades: DONE 2026-09-30 — Node 22 (Dockerfile + engines + @types),
  React 19, react-router 7, vite 8 + plugin-react 6 + vite-plugin-pwa 1.3,
  @hono/node-server 2, pglite 0.5 (dev dirs from 0.2 don't open — move aside),
  pdf-parse 2 (PDFParse class, d.ts shim deleted), vitest 5, lucide 1.49.
  drizzle-orm 0.45 already shipped. Still pending: drizzle-orm →1.0 when
  stable, zod 3→4 (big migration — record/error APIs), npm local: vitest@5
  peer tree crashes npm 10's arborist — install with npm >=10.9/12.
  @esbuild-kit + glob 11 warns are transitive (drizzle-kit/workbox-build).
- .env.example: DONE — full pass, all ~85 vars grouped+commented (billing/
  Twilio/Outlook/WorkOS/gmail-push/caps were the big gaps); legacy vars
  marked. Remaining: keep in sync as env.ts grows.
- Legacy to retire eventually: WORDHOP_API_URL, JANIS_SOCKET_SERVER_URL
  (Heroku relay), LEGACY_SLACK_INTERACTIONS_URL, META_LEGACY_WEBHOOK_URL.

**Marketing surface (missing)**
- GA4 (G-G5W5H3CVR2) — funnel events DONE: shared lib/analytics.ts (track +
  localStorage-deduped trackOnce). sign_up fires once per account when /me's
  created_at <24h (Layout); onboarding steps fire first_agent/agent_online/
  channel_connected/first_conversation/first_takeover on transition to done
  (server-observed truth, not clicks) + onboarding_complete. Still missing:
  server-side GA4 Measurement Protocol (needs GA_API_SECRET — client-side
  gtag is ad-blockable).
- Onboarding checklist: DONE (Onboarding.tsx + /api/onboarding). Still missing:
  public API/SDK docs, security/trust page, pricing/comparison pages.

**Concierge ops — Ask Janis action catalogue (added 2026-10-01)**
- Live tools (writers): create_agent, teach_agent→apply_knowledge,
  add_routing_rule→apply_routing_rule, update_agent→apply_agent_config
  (name/greeting/CSAT/quick_replies/help_url), change_plan; all park
  concierge approval cards (parkConciergeAction) that never page Slack.
  Reads: web_search, account_status, workspace_stats, debug_conversation,
  knowledge_gaps. SSE: agent events invalidate agents/channels/channel/
  knowledge/knowledge-gaps/rules/ask-janis-config; workspace events
  invalidate workspace/me/billing/billing-status.
- Queued — cheap (config allowlist, same card path): widget accent colour
  (channels.meta.branding.accent on the agent's webchat channel),
  escalation email.
- Queued — medium (new tool + executor, same plumbing):
  rescued-conversation → teach card; waiting-conversation → assign-to-me
  card; help-article draft → publish card; contact delete card
  (GDPR-scoped, admin-only — mirror routes/contacts delete semantics).
- Queued — ops breadth (cards for existing mutations): conversation
  tag/note/close/bulk-close cards; knowledge edit/delete + dismiss-gap
  (teach only adds); rule edit/disable/delete (create-only today);
  contact merge + export cards; "run eval suite" card with pass/fail
  result; member admin (invite/remove teammate) cards.
- Queued — trust: undo/revert window on mutating cards (store inverse
  payload in pending_actions.args; offer "Revert" while safe).
- Deferred — need upstream machinery first: eval-regression revert
  (needs prompt version history); campaign send/schedule cards (needs
  concierge-facing campaign lifecycle); repeated-wrong-answer detection
  (needs an evaluator pass); weekly-digest card (scheduled concierge
  summary); usage-limit + failed-payment cards (need Stripe state in
  the concierge prompt); Shopify link-out card (not a mutation).
- Model-honesty backstop: see "Reply-claim verifier" under Reliability —
  same check applies to concierge card-claim phrasing.

**App hierarchy redesign (built 2026-10-02)** — Chatbase-style
context switcher, but the workspace stays a real surface (unlike Chatbase's
admin-only workspace level; contacts merge cross-channel so agent-scoping
the identity graph is wrong):
- Top-left switcher popover: workspace block (avatar, name, plan badge,
  Usage, Workspace settings, Switch/Create-or-join workspace) + Agents
  list (check on selected) + Add agent. (ContextSwitcher in Layout.tsx,
  .ctx-* styles.)
- Copilot (Ask Janis) is ever-present at the TOP of BOTH contexts; when an
  agent is selected the concierge is agent-scoped (its tools default to
  that agent, "this agent" resolves).
- WORKSPACE context nav: Agents · Inbox (all agents — the triage queue) ·
  Contacts (full identity graph) · Campaigns · Reports · Usage ·
  Workspace settings (General/Members/Plans/Billing/API keys/Audit).
- AGENT context nav: Copilot · Inbox (filtered to agent; toggling to
  another agent there switches whole app context) · Behavior (tabs: LLM,
  Greeting + greeting quick-replies/cards, System prompt, Tone,
  Satisfaction survey incl. auto-archive toggle) · Knowledge base (tabs:
  Text, Files, Websites, Gaps, Help center) · Channels · Integrations
  (renamed from Tools) · Chat components (own level, below Integrations) ·
  Tests · Contacts (filtered) · Campaigns (filtered) · Reports (filtered) ·
  Usage (filtered) · Settings (current Escalation tab contents).
- Implementation: agent context is URL-driven (/agents/:id/* — every
  section its own path: inbox/contacts/campaigns/reports/usage reuse the
  workspace pages with an agentId prop; channels/:channelId is the
  channel editor; behavior|knowledge|integrations|components|tests|
  settings render AgentDetail with ?sub= tabs). lib/agentContext.ts
  derives routeAgentId (last-visited agent persists to localStorage).
  Legacy /agents/:id?tab=X redirects map to the new sections; bare
  /agents/:id lands on the agent's inbox. API: ?agent_id= filters on
  conversations/contacts/campaigns/reports/usage (CampaignSegment.agent_id
  covers contact + smart-list + campaign audience filtering); the webchat
  agent_id field stamps the current_agent trait (name) so concierge
  built-ins default to the selected agent via visitorAgent() — explicit
  tool args still win.
- Saved replies: workspace-level AND agent-level — agent replies add to /
  override the workspace set. (TODO: agent-scoped saved_replies + merge —
  the agent editor's Settings → Saved replies tab is ready.)
- Deliberately NOT copying: Playground (redundant — channels are testable
  in place; TODO: agent preview surface in a later phase), Backstage name.
- Default landing when an agent is selected: its Inbox (operator-first —
  the concierge is one click away, ever-present).

**In-conversation widgets — delivery taxonomy (added 2026-10-02)**
- Four emission paths, resolved in order at reply time: tool-bound widgets
  (ToolDef.widget maps a tool result to a spec — most deterministic, model
  never transcribes data) → WIDGET_REF: <name> (resolves an agent_widgets
  row verbatim — team-built content, model only picks the moment;
  refs normalize space/underscore/case so "Pricing Table" hits
  "pricing-table") → WIDGET: {json} (model freehand — least predictable)
  → BUTTON:/quick_replies. All cap at 3 per reply; tool-bound lead.
- Authoring: agent page → Tools → "Saved components" composer
  (WidgetComposer.tsx) — cards/options/form/status/receipt editors + live
  preview; auto_greet pins a component under the webchat greeting
  (bootstrap greeting_widgets → widget.js + Ask Janis rail). The concierge
  reaches the same table via the save_widget builtin (approval card →
  apply_save_widget executor re-validates the spec, upserts agent+name) —
  "add this widget to X" must land there, not update_agent (settings).
- Delivery: payload.widgets on the stored message → webchat/Ask Janis
  render the real components (ChatWidgets.tsx mirrors widget.js); Meta
  channels translate — Messenger generic-template carousel (default_action
  opens card links), WhatsApp interactive lists; SMS/email flatten to text.
- API: GET/POST /api/agents/:id/widgets, PATCH/DELETE /:wid — spec is a
  validated WidgetComponent; unique per agent+name (upsert on POST).
- Predictability rule of thumb: content the business owns → saved component
  or tool-bound widget; content the conversation owns → WIDGET:. The model
  should never hand-transcribe tool results into WIDGET: JSON.
- Data-bound components (Chatbase-style, added 2026-10-02): agent_widgets
  rows carry `states` ([{name, spec}] — full variant specs the ref data's
  "state" key selects) and `tool` ({name, args, props, items, item_map} —
  the ref's data feeds the tool's args, its JSON result maps into {prop}
  placeholders and list items). Ref syntax: WIDGET_REF: name {"order_id":
  "#1932"} — args → bound tool (identity-checked like the tool loop, gated
  tools rejected), props → {placeholder} strings in the spec, state →
  variant spec. resolveWidgetRef() in hostedAgent.ts orchestrates;
  interpolateSpec/specProps/stripEmptyStrings in widgets.ts. Greeting pins
  interpolate empty — a placeholder spec fails validation and drops rather
  than leaking "{status}" to visitors.
  TODO (owner feedback: current binding UX is unintuitive): convention-first
  simplify — {path} placeholders dig straight into the tool's JSON result
  (drop tool.props/item_map); cards/options take a single "rows" path with
  per-row template interpolation (or auto-detect first array); ref data keys
  pass through as tool args by name (drop the args rename map, digest lists
  the tool's declared params so the model writes them correctly — identity
  params like email still auto-fill); composer shows the tool's params and a
  sample-data preview instead of the raw mapping JSON.

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
