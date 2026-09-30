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

**Infra / reliability**
- Multi-instance: DONE — bus_events SSE relay, viewers + voice_queue tables,
  sweeper_locks leader election (sweeps, gmail poll, digests). Deploy raises
  --max-instances to 3 (MAX_INSTANCES env override) on DATABASE_URL mode.
- Scale tail (2026-10): DB pool explicit — DB_POOL_MAX (default 8) sizes the
  postgres-js pool per instance (≤24 conns at 3 instances vs Neon pooler
  budget); job runner claims all due rows then runs handlers JOB_CONCURRENCY
  (8)-wide under the sweeper leader lock (claim-first unchanged — crash
  leaves 'running', reclaimed at attempts<5/5min stale); migrations moved to
  a pre-deploy step (see Deploy). In-process state audit: safe — TTL caches
  (cap/token/avatar/greeting/sub), slack channel+thread-status caches
  (lazy-refill), typing-relay dedup; KNOWN GAPS — convRuns per-conversation
  agent run-guard is per-instance (two instances could both start a hosted
  reply for the same conversation on racing inbound; fix = DB-claim row or
  agent.run job dedup) and meta OAuth `pending` map is same-instance-only
  (connect flow can die if the callback routes to another instance; fix =
  DB-backed state or self-contained signed state). Voice bridge has no
  module state — queue lives in voice_queue.
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
- E. Operator docs — /docs covers only the agent API; nothing for
  campaigns, send policy, suppressions, CRM sync, approvals, Slack
  takeover, saved views. Reuse help-center renderer.
- F. Accessibility sweep: ~27 aria attrs total; icon-only buttons on
  title= only; focus rings + landmarks for procurement questionnaires.
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
  13 articles on prod Demo Agent + Janis agent. Missing: full-text ranked
  search (tsvector — ILIKE only today), article view counts, helpfulness
  votes, zero-results search log (feeds content roadmap), version history,
  widget article embeds.
- Marketplace: webhook template + event export cover Zapier manually; no
  published Zapier app (listing/submission = highest-leverage non-code task),
  no one-click OAuth installs, no public /integrations directory. Outbound
  webhooks have retries + deliveries/replay UI (DONE — see Webhook ops).
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
  /usage (messages vs plan included + LLM cost/tokens + voice seconds,
  current vs previous period — card on Reports), /export?kind=
  conversations|campaign_sends (CSV, scope-filtered, 5k-row cap).
- Still missing: FRT/resolution-over-time charts (point-in-time today).

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
- Load test: scripts/load-test.js (k6) — staged 10→150 RPS on health +
  session-auth'd reads, p95<800ms / <1% errors thresholds; run against a
  preview revision, never prod at 150rps without warning. Read-only by
  design (writes pollute CRM write-back + billing meters).
- Backup/restore runbook (Neon PITR exists — unrehearsed): rehearsal = Neon
  console → Branches → new branch "from a point in time" → psql into the
  branch endpoint, verify a known row (e.g. newest campaign_send) → delete
  branch. For real restores prefer branching + cutover over overwriting the
  primary branch. Still missing: Cloud Monitoring 5xx/latency alert policy
  → Slack webhook (log-based metric on status>=500 in the run.googleapis
  log; janis.alert ERROR markers already exist as an anchor).

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
- Stack upgrades: Node 20 → 22/24 LTS (engines + Dockerfile node:20-alpine
  + @types/node — Node 20 EOL 2026-04). drizzle-orm 0.38→0.45 has a HIGH
  SQL-injection advisory fix (breaking upgrade — smoke-test migrations).
  react-router 6→7 (moderate advisories, breaking), React 18→19,
  @hono/node-server 1→2, pglite 0.2→0.5, pdf-parse 1→2, vite/plugin-react
  majors. Deprecated warns: @esbuild-kit (merged into tsx), glob 11.
- .env.example documents ~30 of ~80 vars — needs a full pass w/ comments
  on which are dev-defaulted vs required.
- Legacy to retire eventually: WORDHOP_API_URL, JANIS_SOCKET_SERVER_URL
  (Heroku relay), LEGACY_SLACK_INTERACTIONS_URL, META_LEGACY_WEBHOOK_URL.

**Marketing surface (missing)**
- GA4 (G-G5W5H3CVR2) fires landing-page demo/CTA events only — funnel events
  still missing: signup, first_agent, first_conversation, channel_connected.
- Onboarding checklist: DONE (Onboarding.tsx + /api/onboarding). Still missing:
  public API/SDK docs, security/trust page, pricing/comparison pages.

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
