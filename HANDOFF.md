# Handoff — read this first if you're a fresh agent session

You are continuing work on Janis.ai with Mike (mnatha). This file carries
the context a long session accumulated so a new session doesn't have to.
**`AGENTS.md` remains the canonical rules file** — dev commands, deploy
procedure, billing details, gotchas, the open-work tracker, and the
verification ritual all live there. Read it before doing anything.

## Product mission

Janis.ai is being revived and commercialized as a hosted, human-assisted
AI customer-service SaaS. Mike owns it; it has a few legacy clients left.
Positioning:

> "AI when AI is best. Humans when humans are needed. One seamless
> customer conversation."

Target end state: hosted/BYO AI agents, human takeover, unified inbox,
multichannel (webchat widget/Bubble, email, Slack, Meta, WhatsApp, voice),
approval-gated agent actions, rescue → regression-test → knowledge-gap
learning loop, routing rules with named groups, CRM sync, campaigns,
conversion tracking, CSAT, reporting, billing (Stripe, incl. agency
rebilling via Connect), enterprise tail (SSO/SCIM done, env-gated).

The agent builder is organized as stages: **Create → Teach it → Guide it →
Abilities → Try it → Deploy**, under an AGENT / BUILD / CONFIGURE nav.

## Repo facts

- npm workspaces monorepo at `~/repos/janis` (NOT iCloud — sync corrupts
  files; see AGENTS.md gotchas).
- `apps/api` — Hono + Drizzle. PGlite locally, Postgres (Neon) in prod.
- `apps/web` — React + Vite PWA. `packages/shared` — zod contracts
  (resolves to dist/ — rebuild after editing). `packages/sdk`.
- Login (local seed): `admin@janis.local` / `janis-admin`.
- Dev: `npm run dev -w apps/api` (:8787) + `npm run dev -w apps/web` (:5173).

## Credentials & secrets — where they live, not the values

Never commit secret values. Sources of truth:

- `apps/api/.env` — local dev (currently LIVE Stripe keys; test-mode
  equivalents kept alongside as `*_TEST` vars — swap for billing work).
- `apps/api/.env.production` — DATABASE_URL, RESEND_API_KEY,
  JANIS_EMAIL_FROM (used by the task-summary ritual — see AGENTS.md).
- Stripe live webhook + price ids: enumerated in AGENTS.md §Billing.
- `JANIS_SEARCH_API_KEY` — unset, platform web-search tool is dead.

## Verify after EVERY change (AGENTS.md §Verify)

```
npm run typecheck
npm test -w apps/api
npm test -w apps/web
./scripts/smoke.sh
```

Run smoke BEFORE telling Mike to reload a preview. SSE check needs an
existing conversation (warn is OK). Only one `tsx watch` per PGlite dir.

Commit style: imperative, terse, "why" over "what"; trailer:
`Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>`.

## Current architecture state (what exists — don't rebuild)

- **Team rosters** — workspace (Settings → Team) and agent (Agent →
  Team) share `apps/web/src/components/TeamTable.tsx` + `TeamRow` +
  `MemberCell`. NEVER duplicate table markup again — Mike called this out.
  Sorted: self first (`(You)` badge), then alphabetical.
- **Notifications** — baseline on `users.notifyPrefs` (account-level —
  caveat: follows a user across workspaces), per-agent overrides on
  `agentMembers.notifyPrefs` (`resolveNotifyRecipients` merges
  field-wise). Both tables have an Alerts pencil opening a modal editor;
  admins edit anyone, members edit themselves (`PATCH /api/users/:id`
  accepts `notify` for admins; `/me` for self). Event labels shared at
  `apps/web/src/lib/notifyEvents.ts`. Device push toggle is self-only.
- **Name uniqueness** — one namespace per workspace: agents and groups
  (workspace- AND agent-scoped) can't share names, case-insensitive,
  trimmed. `apps/api/src/lib/names.ts` (`agentNameTaken`,
  `groupNameTaken`, optional excludeId). Enforced on POST/PATCH/
  bootstrap; 409 with `"X" is already a(n) agent's/group's name`.
  Existing dupes not migrated.
- **Groups** — `member_groups` has nullable `agent_id`; workspace groups
  apply to all agents, agent groups scoped to one. Shared UI component:
  `apps/web/src/components/MemberGroups.tsx` (used by both Team cards).
- **Settings layout** — Workspace | Me | Sending | Escalation | Team.
  Escalation mirrors the agent's: Slack alerts, Profile (baseline the
  agent override inherits), Saved replies. CRM sync is under Workspace.
  Integrations tab is GONE.
- **Agent Escalation tab order** — Slack alerts → Alert & routing rules →
  Human takeover → Profile override → Saved replies.
- **Agent builder** — `apps/web/src/pages/AgentBuilder.tsx`, stages per
  nav above.

## Recently shipped (Oct 29–30, 2026)
## 2026-11-04i — Conversation-switch loader + placeholder-data guards
- useConversation keeps the prior thread mounted via placeholderData;
  while the next conv fetches, a zero-height sticky `.conv-fetch` pill
  ("⟳ Loading…") pins over the faded transcript — no flow space, so
  nothing shifts when the new thread lands. Cached convs and the 15s
  poll never show it (isPlaceholderData is only true on the key-change
  fetch window).
- Same window needed effect guards — every consumer of `data` acting on
  route `id` was re-keyed to `data.conversation.id === id`: auto-mark-
  read (was stamping markedReadFor against the OLD conv's flags, so the
  arriving unread thread never marked read), the merged_from redirect,
  ?scroll= restore, ?msg= jump, and loadOlder.
- Probe: scripts/ui/tmp-convloader.mjs delays /api/conversations/:id
  and samples the DOM across the switch — asserts pill + .switching
  fade + chrome mounted, cleared on arrival, absent on cached switch.
- Cold loads got skeletons the same day (5703a5c0): the !data gate was a
  blank "Loading conversation…" void over the whole three-pane layout —
  now mirrors the real columns (ConvRowSkeleton rows, head, action icons,
  transcript bubbles, composer, labeled rail cards) with nav-skel-pulse
  blocks; inbox list's spinner gate uses the same row skeletons.
  Probe: scripts/ui/tmp-skel.mjs.

## 2026-11-04h — Operator brief: on-demand Summarize card
- GET /api/conversations/:id/summary writes a one-look digest (headline +
  labeled bullets) through the agent's own LLM via complete(); cached as
  conversations.op_summary keyed to last activity (op_summary_up_to), so
  a request only pays for a new pass when the transcript advanced —
  ?refresh=1 forces one. In-flight map dedupes concurrent clicks; BYOK
  agents run on their own key; workspaces over the 24h AI ceiling and
  threads under 6 visible messages get {summary:null, reason} — reason
  ('short'|'no_llm'|'over_cap'|'error') is what the card says on a miss.
- Console: a Summarize toggle in the conv-actions toolbar (ScrollText
  icon, next to Ask Janis) reveals the card above the transcript — ON
  DEMAND only, no fetch on entry (Mike rejected the auto-show card as
  interface-blocking). Dismiss X closes; refresh ↻ regenerates.
- Gotcha for future summary work: lastMessageAt is ingest-stamped a few ms
  AFTER the newest message's createdAt — stamping a cache cursor with the
  message ts alone reads permanently stale. Stamp with max(lastMessageAt,
  newest createdAt).

## 2026-11-04g — Concierge action cards decidable only by the verified visitor
- The /api/actions/:id/decide member-fallback admitted OPERATOR-workspace
  members on concierge (action proposed) cards — the concierge agent lives
  in that workspace, so an operator's Approve would execute writes into
  the visitor's own workspace under the visitor's re-verified admin
  rights. Now only p.external_id === caller decides; everyone else 404s.
- Console inbox renders visitor-decision cards read-only for non-visitors
  ("Waiting on {name} — only they can approve"); 'action proposed' vs
  'approval requested' payload.event is the discriminator.
- Internal note attribution fixed: visitor self-decisions resolve to the
  visitor's name (their user id isn't a member), unauthored internal
  notes resolve to the agent — was blanket "Operator".

## 2026-11-04f — Zapier card on agent Integrations (embed surface)
- Agent Actions tab gets a static "8,000+ more apps via Zapier" card
  under the catalog grid — blurb covers both directions (triggers on
  new/escalated/resolved, actions back into Janis), links the live
  directory listing, and a secondary button jumps to Settings →
  General → API keys (the credential Zapier asks for). Not a tool
  template — external automation on agent API keys.
- The generated Zapier Workflow Element mounts inside this card once
  Mike publishes zap templates + whitelists embed domains in the dev
  platform (both are his-login steps).

## 2026-11-04e — Zapier approved: Janis is live in the public directory
- Platform review passed (after the 11-03 desc fix — no other-app
  names); invite code retired, app is searchable/installable by anyone.
  90-day beta runs to ~2026-02-02 → Partner Program; embedding zap
  templates / Full Zapier Experience exits beta early.
- Housekeeping done: "Zapier review" API key on prod Demo Agent revoked
  (was minted for the reviewer's test account 2026-10-28).
- Beta-phase backlog now open: zap templates in-product, Powered-by-
  Zapier embed, help doc, Partner Sandbox. Future version changes ride
  promote→migrate→deprecate without a full re-review.

## 2026-11-04d — Visitor-facing Slack channels (shared app OR bring-your-own)
- New 'slack' channel kind — an agent answers in bound Slack channels +
  (opt-in) bot DMs. conversations key slack:{team}:{user}; the reply lands
  wherever they last spoke (payload.slack stamp on the inbound message is
  the reply pointer — channel + thread anchor, read back by sendSlackReply
  like email's threading headers).
- Two credential flavors on one channel row: via 'oauth' rides the existing
  shared Janis app install (slack_installation_id — all needed scopes were
  ALREADY in the install set: chat:write.customize, channels:join,
  im:history, users:read.email); via 'manual' is the customer's own
  white-label Slack app — bot_token+signing_secret on the channel, Events
  URL /slack/ext/:id/events, manifest from /api/channels/:id/slack-manifest.
- Routing: /slack/events claims bound surfaces BEFORE concierge (claims
  only match creds.slack_channel_ids / slack_dm — unclaimed DMs + mentions
  elsewhere still go concierge; classic-mode installs untouched).
- lib/slackChannel.ts is the new home: claimsVisitorEvent,
  visitorChannelFor, visitorSlackInbound, sendSlackReply (thread_ts anchor,
  mrkdwn via slackMrkdwn, persona via username=operator|agent name),
  joinBoundSlackChannels (auto-join on save; private channels need member
  invite — surfaced as slack_join_errors on create/patch).
- Console: Slack card on agent Integrations (install picker + channel
  multi-pick + DM toggle + BYO form); channel page gets Listening surfaces
  + Your Slack app (events URL, manifest) sections.
- Slack directory emails store as contact email but stay UNVERIFIED —
  ToolDef.identity tools don't see them. Per-thread ticketing (each post =
  its own conversation) is deliberately not done: per-user continuity.
- Deferred: Slack files/attachments, native quick-reply buttons (rendered
  as a bullet list), @mentions in unbound channels going to concierge on
  community installs, per-thread (vs per-user) conversation mode.
- Committed + pushed 5e1919a; NOT deployed per Mike.

## 2026-11-04d — Sign-in captures the OAuth profile photo
- Google + Slack sign-in read `picture` from userinfo → users.avatar_url
  via findOrProvisionUser. Refreshes on every sign-in EXCEPT a user's own
  /uploads/ avatar, which never gets stomped. Existing users pick it up on
  their next login — the concierge/identify picture_url path then carries
  it automatically.

## 2026-11-04c — Host-asserted avatars via Janis.identify({ avatar_url })
- identityClaim accepts avatar_url; verifyIdentitySig returns
  {verified, avatarSigned} — the avatar is honored only when the signature
  covers it (hosts sign id|email|name|avatar_url; legacy 3-field sigs
  still verify identity, avatar ignored). Rationale: picture_url is
  fetched SERVER-side — an unsigned/swappable claimed url would be a
  blind-SSRF primitive. Tampered avatar under a 4-field sig fails
  verification entirely.
- Flows: resolveIdentity → msg.user.avatarUrl → picture_url (both the
  /identify patch path and per-message baseProfile merge) → contact
  avatar_url via enrich coalesce. Janis-user avatar still wins when the
  claim id is a real user (cross-origin session form).
- Docs updated: channel settings WebchatIdentity block + widget.js
  docstring — sig input is `filter(Boolean).join('|')` over id/email/
  name/avatar_url.

## 2026-11-04b — Tier-3 scenario judge stops over-matching live replies
- Every concierge inbox reply was attaching the "unintelligible input"
  scenario (Expected bar + hides Save-as-scenario): matchPromptsSemantically
  numbered only the FIRST line of each multi-line exchange, so scenario
  boundaries bled and the judge (the agent's own model — flash-lite here)
  matched on topical similarity. Now `=== SCENARIO N ===` / `=== INPUT N ===`
  block delimiters + a bias-to-null MATCH_SYSTEM. Verified vs prod data:
  flash-lite + 4o-mini null the two real queries, still hit paraphrases/
  typos on all positive controls. Same helper backs save-as-scenario
  dedupe and /tests/match. Committed + pushed 7f9c8b5; DEPLOY HELD by Mike.

## 2026-11-04a — Sender avatars: Gmail/Gravatar/Slack hydration + contact route
- fetchPlatformProfile generalized per kind (gained a db param): Meta
  unchanged; gmail → People API otherContacts (sender's Google contact
  photo — needs contacts.other.readonly, added to the Gmail connect
  scopes; pre-scope tokens 403 → Gravatar); email/outlook → Gravatar
  (md5(email), probed with ?d=404 so has_avatar stays honest). Misses now
  stamp profile_fetched_at so the stale check stops re-probing every
  inbound; pre-existing email convos pick avatars up on their next message.
- Slack concierge threads: slackUserToMember captures profile.image_192/72/48
  on the users.info leg; hydrateSlackAvatar (once per member per process,
  opt-in) fills users.avatar_url — called at the concierge DM site, NOT in
  the resolver whose fast path stays users.info-free by contract. The
  concierge user payload now passes avatarUrl → picture_url.
- Contact avatars were a dead end: toContact null'd avatar_url and no route
  served it. New GET /api/contacts/:id/avatar → fetchContactAvatar serves
  the row's avatar_url, falling back to the newest linked conversation's
  picture_url (covers pre-enrich rows). has_avatar on list+detail counts
  the fallback via an exists() subquery; Contacts page renders it.
- Still unavailable: whatsapp/sms/voice (no provider endpoint) and
  foreign-app PSIDs (Meta app-scoping wall — name only via participants).

## 2026-11-03d — Arg misses (workspace/agent) are results, not Run alerts
- Same rail conv, 22:35 UTC: copilot passed workspace="OAuth review
  workspace" (hallucinated — conflated the contact's account traits with
  an operator workspace, the confusion 2026-11-03b prompted against). The
  {"error"} reply marked the tool call failed and fired a Run alert.
- 0836854's miss-not-failure rule now covers visitorWorkspace,
  visitorAgent and changePlan's inline resolution: bad/absent hints
  return {result:'no_matching_*'|'ambiguous_*', hint, workspaces|agents}
  so the model self-corrects without alerting. Real states (unsigned
  visitor, no admin workspace) keep {"error"}.

## 2026-11-03c — Inbox rows go Gmail: flat list, unread two-tone, hover rail
- ConvRow rebuilt as a mail-list row: checkbox → star toggle → alert/unread
  dots → avatar → sender column → label chips (agent/channel/test/intent/
  snooze) → preview → tail (state badge + Gmail-style stamp + hover rail).
  Flat hairline-separated rows replace the 8px-gap cards.
- Unread/read: unread rows get bold name + bold bright preview on the
  same flat bg (no two-tone, no dot on desktop — weight carries it);
  read rows are regular weight and muted. Mobile shows the unread dot
  right of the timestamp (Gmail-app style).
- Hover rail (pointer devices only): archive/unarchive, mark read/unread,
  snooze (moon-over-select, same SNOOZE_OPTIONS), delete — replaces the
  timestamp on hover. The checkbox stays visible (deliberate deviation
  from Gmail's hover-reveal — bulk triage is a primary flow here).
  Delete still goes through the confirm dialog.
- Chips moved out of the sender column into .tags so the name keeps its
  width; the agent tag now only renders when the row's agent differs from
  the current context (was redundant noise on scoped inboxes).
- Mobile (≤720): two-line rows — name+chips line 1, preview line 2,
  timestamp top-right, badge beneath; chips wrap under the name when the
  line fills (label-row look). Touch gets the same verbs via select +
  bulk bar; no hover rail.
- Timestamp switched from timeAgo to a Gmail stamp: clock time today,
  "Nov 2" this year, "11/2/25" older.

## 2026-11-03b — Copilot: 'this conversation' referent + contact-account scoping
- Prod transcript (rail conv u:1bb91d38…, 19:04–19:13): on ambiguous asks
  ('what conversation is this', 'who is the customer in this thread') the
  model guessed with zero tool calls — fabricated a conv id (c-87d2938e)
  then answered from the rail's own context. It only called
  read_conversation once 'in the inbox' was explicit; the tool+page-trait
  pipeline itself worked correctly.
- Also conflated a contact's account.plan/role/workspace traits (the
  person's OWN Janis account) with the operator's workspace — told Mike a
  contact was 'an admin in your workspace' and argued that 'OAuth review
  workspace' was named 'OAuth review'.
- Operator prompt (hostedAgent.ts) now disambiguates: bare 'this
  conversation/thread/customer' referents prefer the open page over this
  chat (resolve via tool, never from the rail's own details), and
  account.* traits are the contact's own workspace, never the operator's.

## 2026-11-03a — Inbox suggestion card follows composer mode, sparkles is a toggle
- Bug: the Suggested-reply card was gated on conversation state==='human',
  so "Reply as yourself" while the agent still held the thread hid it —
  the moment operators most want the draft. Card now follows sendAs:
  visible for human/agent reply modes, dismissed (pending suggestions
  POSTed 'dismissed', not just hidden) on switching to note/teach.
- Sparkles button no longer unmounts while its card is open — it shows
  a pressed-in accent state (.btn.suggest-on, same grammar as
  filter-on/verdict-on), toggles the card off on click, and renders
  disabled (tooltip "Suggestions apply to visitor replies") in
  note/teach. New Composer prop: suggestActive.
## 2026-11-02t — AWS account fully decommissioned (was billing $42/mo)
- Mike got an AWS invoice: $39.61 Lambda + $2.45 CloudWatch, API GW $0.
  Root cause: 4 ENABLED EventBridge cron rules from the OLD system still
  firing every 1–5 min into janis-api-* lambdas — updateSubscriptions ran
  every 3 min averaging 167s (hanging on the dead Mongo) ≈ 90% of the bill.
- NOTHING in the reboot calls AWS. The only wires were JANIS_AWS_API_URL
  env vars on wordhopapi/wordhop-slack/janis-web (dead code — every
  API-facing lambda showed 0 October invocations).
- Torn down via temp IAM user devin-audit (deleted after): 5 EventBridge
  rules, 3 CFN stacks (janis-api, serverlessrepo-janis-api-toolchain,
  serverless-react-foil-test-dev, aws-sam-cli-managed-default), 30 lambdas,
  4 API Gateways (incl. kaklluzeld + cjx0ezfxv4 the apps pointed at),
  5 S3 buckets, all /aws/lambda/* + codebuild log groups, stuck IAM
  roles/policies. JANIS_AWS_API_URL unset on all three Heroku apps.
- Left standing (all $0 idle): 5 SES identities (janis.ai, support@janis.ai,
  jottoplay.com, tangerinetorpedo.com) and AWS-managed KMS keys. No EC2,
  RDS, Route53 zones/domains, NAT, or ELB anywhere — Nov bill ≈ $1.30
  prorated, then ~$0.
- Gotcha for next time: PowerUserAccess can't delete IAM roles; deleting
  a stack's service role first forces a recreate-then-delete dance.
## 2026-11-02s — WooCommerce connector card
- Second e-commerce provider after Shopify. Credential card only —
  WooCommerce's auth is consumer key/secret (Basic auth against the
  store's own host), self-serve in WC admin with no marketplace gate.
  Tools: woo_lookup_order + woo_customer_orders (identity-bound — order
  reads only against verified emails), woo_search_products,
  woo_add_order_note (approval-gated, private staff notes).
- wc-auth DOES have an app-approval flow upstream but it POSTs creds to
  a callback rather than exchanging an auth code — doesn't fit the
  generic OAuth factory; credential card is the v1.
- Fin-catalog gap review (their 60 tiles): we natively cover ~15 of the
  45 API tiles + MCP-extend to ~25. True remaining gaps: Freshdesk,
  BigCommerce, DB connectors (pg/mongo/snowflake — MCP-able),
  knowledge-source imports (Guru/Slite/Notion→KB), product/marketing
  reads (Segment/PostHog/Mailchimp/SendGrid), accounting (QB/Xero),
  Discord channel, Statuspage.
## 2026-11-02r — Custom domains as an upsell; RESEND_CUSTOM_DOMAINS flipped on
- RESEND_CUSTOM_DOMAINS had been =0 on prod since Oct 20 — flipped to 1
  (untracked deploy-consumed file) when the feature went live. Account is
  on Resend FREE: 3 domain slots, all ours (janis.ai/mail/inbound) — the
  Resend plan needs upgrading before ANY client registration succeeds.
- Domain cost is passed to the client: lib/domainBilling.ts — Pro/Scale
  include 1 domain; anyone buys more via POST /api/billing/domain-addon
  ($5/mo/domain, DOMAIN_ADDON_USD). Price self-heals via Stripe
  lookup_key janis_domain_addon (live+test, no env IDs). Paid sub →
  prorated item; free workspace → checkout session (metadata addon:domain
  keeps plan-flip webhooks from treating it as a plan sub).
- Gate lives in the email-domain mounter's register (checkDomain opt —
  one spot covers channel+agent): counts distinct domains across the
  workspace's channel creds + agent email_sending bags, 402s with
  domain_addon flag → the card renders an "Add domain — $5/mo" CTA that
  buys and retries. Re-register/adopt doesn't consume a slot.
- Remove on a domain that feeds an email channel now asks first —
  EmailDomainCard.removeWarn + useConfirm names the affected channels.

## 2026-11-02q — Card uninstall drops the creds it installed
- agent_secrets used to survive card removal forever (torontofood kept
  SHOPIFY_TOKEN with zero shopify tools — reads as "still connected").
  DELETE /:id/tools/:template now GCs the template's creds: candidates =
  {{secrets.*}} refs on the removed defs (covers dynamic MCP_<slug>_*
  names) + the template's produced names via a dummy-field probe of
  secrets() (covers server-side-only creds like SHOPIFY_STOREFRONT_
  PASSWORD that never appear in a placeholder).
- Survivors: names still referenced by remaining tools (shared creds for
  custom tools) and SHOPIFY_* while a shopifyShops 'linked' row owns the
  mirror. Mirrors the existing gcUnusedConnections behavior for CONN_*.
- No template provenance on agent_secrets — operator-added secrets via
  PUT /:id/secrets are untouched (not candidates).
## 2026-11-02p — One sending domain, one management spot
- A domain already registered on an email channel now pre-populates the
  agent Email sending surfaces: effectiveEmailSending(cfg, channels)
  resolves agent bag ?? channel bag for display; the agent email-domain
  routes adopt the channel's bag into config.email_sending on first write;
  agent DELETE cascades — strips the same domain_id + dependent
  from_address off the agent's email channels too.

## 2026-11-02o — Domain setup surfaces inside the Integrations section
- The Channels-page Email sending card wasn't discoverable: a
  Shopify-installed merchant never opens Channels. New EmailSendingNudge
  sits right under IntegrationCards on the agent's tools/integrations
  section — when cfg.tools contains an identity-bound tool and no verified
  domain, it renders the inline EmailDomainCard (same endpoints) with a
  "Send the verification code as you" pitch.

## 2026-11-02n — Email-sending onboarding nudge + recovery mail rides the agent domain
- Customer-facing email audit: verification codes (agent-domain since -i/-l)
  and abandoned-checkout recovery mail are the two shopper-facing sends;
  everything else is Janis→operator (auth, invites, migration, data-request,
  form destinations, alerts) and correctly stays on the Janis sender.
- Recovery mail now sends `from: {from_name|store} <{from_address|no-reply@domain}>`
  when the agent's email_sending domain is verified — was "Store via Janis
  <recovery@inbound.janis.ai>". Reply-To stays the merchant's shop contact.
- AgentChannels Email sending card shows a contextual hint when the agent
  has identity-bound customer-record tools installed (order lookups that
  fire send_verification_email) and no verified domain — "right now it
  arrives as Janis; verify a domain and it comes from you."

## 2026-11-02m — MCP client: long-tail connector via remote tool discovery
- `mcp-server` catalog template: operator supplies a name slug + server
  URL + optional bearer → install calls tools/list on the server and
  materializes stamped defs (mcp_<slug>_<tool>). Covers hosted MCP
  servers (Asana/Sentry/Airtable-style endpoints) — no bespoke template
  per provider. Reinstall re-syncs wholesale (server-dropped tools leave).
- ToolDef gains transport:'mcp' + mcpTool + inputSchema: callTool
  dispatches to JSON-RPC tools/call (mcpClient.ts — streamable HTTP only,
  JSON and SSE responses, mcp-session-id handled, re-initializes every
  call so nothing session-shaped is stored) and hostedAgent hands the
  server's own inputSchema to the model instead of flat string params.
- Security defaults: readOnlyHint&&!destructiveHint → autonomous,
  everything else approval-gated (operator can still toggle — it's their
  server); discovered tools NEVER take identity (no customer-record
  binding on arbitrary remote tools); bearer token lives in
  agent_secrets, interpolated server-side only. inputSchema dropped over
  20KB (hostile-schema bloat guard).
- PATCH/DELETE on dynamic templates scope by the `template` stamp — the
  static tpl.tools list is empty for MCP so name-matching saw nothing.
## 2026-11-02l — Agent-level Email sending: custom domain without an email channel
- The custom sending domain machinery was trapped inside email-channel
  settings — a Shopify + webchat-only client had nowhere to enter a
  domain, so verification codes could never come From them.
- AgentConfig.email_sending (agents.config) now holds the same bag
  channel credentials carry: email_domain*/records/cf_refresh_token +
  from_name/from_address. Server-managed — agent config PATCH preserves
  the stored bag (stale-tab saves can't clobber it), toAgent scrubs the
  CF token to cf_connected.
- The email-domain route family extracted into lib/emailDomainRoutes.ts
  (mountEmailDomainRoutes: load/save/stateKey/inboundFromAllowed adapter)
  and mounted on BOTH /api/channels/:id and /api/agents/:id — register,
  verify, dns-setup, cf-connect, cf-setup, delete, plus new PATCH
  /:id/email-sending (from_name/from_address, gated to the verified
  domain; channels additionally allow inbound-domain addresses). The
  shared cf-callback reads state {ch|ag} and lands on /agents/:id/channels.
- sendVerificationMail prefers: bound channel → agent's verified domain
  (From: from_name|agent.name <from_address|no-reply@domain>, Reply-To to
  that mailbox) → custom-domain channel → gmail/outlook → plain channel
  → env sender. sweepEmailDomainStatus also refreshes agent-level domains.
- UI: EmailDomainCard parameterized (basePath/meta/onChanged/verifiedHint)
  and rendered on the agent Channels page as "Email sending" with
  send-as fields once verified.

## 2026-11-02k — Notion OAuth connect card
- `notion-connect` + `notion` (internal-token) cards via the generic OAuth
  factory. Quirks: token exchange wants the client pair in HTTP Basic
  (not body) + JSON grant; bot tokens never expire → noRefresh +
  staticToken (stored access token serves, no mint); workspace_name is
  the label; every tool call needs `notion-version: 2022-06-28` (kept on
  the clone via the variant `headers` swap).
- Tools: notion_search, notion_get_page, notion_read_page (block
  children), notion_query_database, notion_create_page (approval-gated).
  Database query ships WITHOUT a filter param — `{filter?}` emits
  `"filter":null` and Notion's validation rejects it; filtering is a v2
  candidate via a dedicated optional-member body syntax.
- Capabilities/redirect URIs are set on the Notion integration itself
  (notion.so/my-integrations → public integration), not the authorize
  URL (owner=user is the only nonstandard param). NOTION_CLIENT_ID/SECRET
  env stubs; card shows "not configured" until they land.
- This is the LIVE-TOOLS Notion connector; deeper knowledge-source
  import/embed sync remains separate future work.
## 2026-11-02j — Approval gating + concierge misclassification + reverse-sync
- jira/linear/github create_issue are now approval-gated (same class as the
  already-gated *_add_comment — catalog flag, operators can't un-gate).
  Kills the silent/over-eager filing seen in the torontofood test chat
  (JAN-7..10 incl. a literal "Don't forget the peas" ticket) — lite
  models ignore description nudges on mutations.
- isConciergeAction(workspaceId, userProfile) matches ANY
  identity_verified conversation on env.operatorWorkspaceId — including a
  regular agent's test chat where the customer verified by email. Two
  call sites misfired on it: /api/actions/:id/decide 404'd member
  approvals (it demanded external_id === user.id, the concierge
  self-decide rule), and decidePendingAction posted the deterministic
  "Done — ran" + skipped resumeAfterDecision. Both paths now require the
  decider to BE the verified visitor; member approvals on customer convs
  take the normal workspace path + agent resume (reports "KAN-4 filed").
- Provider webhooks (reverse sync — Intercom-borrowed): POST
  /webhooks/linear/:agentId (linear-signature HMAC verified) and
  /webhooks/jira/:agentId/:token (URL token — Jira doesn't sign).
  Terminal transitions post a customer-visible "ticket marked Done" note
  into the filing conversation; dedupe on payload.closed_ticket. Auto-
  registered at OAuth-connect with per-connection secrets kept across
  reconnects. REQUIRED new scopes: linear +write, jira +manage:jira-webhook
  — existing connections must be RECONNECTED once to grant them (the
  token is server-side only; tools stay the trust boundary). Webhook
  registration is best-effort — a 403 on old-scope tokens just skips.
## 2026-11-02i — Verification codes send from the client's own mail identity
- send_verification_email always went out as "Janis <alerts@janis.ai>"
  (env.emailFrom via notify.sendEmail), even for agents whose email
  channel already sends client-branded mail.
- New sendVerificationMail resolves the agent's email-family channel —
  the conversation's bound channel first, then best of: verified
  custom-domain Resend sender (from_address on email_domain), a connected
  Gmail/Outlook mailbox (sent through their API, lands in their Sent
  folder), or a plain inbound-address channel (branded display name +
  Reply-To back into the inbox). Any failure falls back to the env sender
  — delivery beats branding. Also lets a gmail/outlook channel carry the
  send when RESEND_API_KEY is unset.

## 2026-11-02h — Dead-tool postmortem: Linear braces, SF URL, Jira discovery
- Found via a torontofood test chat that reported "no tickets" + deflected
  on filing. Root causes, all in the 11-02 connector wave:
  - linear_search_issues / linear_get_issue / linear_add_comment shipped a
    stray extra `}` in the GraphQL doc → GRAPHQL_PARSE_FAILED every call.
    New test asserts brace balance on every catalog query doc (fetch-mocked
    tests only ever saw the JSON envelope).
  - Salesforce OAuth stores instance_url WITH https:// (token response
    verbatim); tools prepend https:// again → every call fetch-failed.
    connectionSecrets now strips scheme + trailing slash on exposed fields.
  - jira_create_issue's param hint literally suggested "SUP" — model
    hallucinated it (no grounding tool existed).
- jira_list_projects added (unbound, read-only) so the agent discovers real
  project keys. toolsFor now backfills catalog tools added to a stamped
  template after install — existing OAuth/BYO installs pick up new sibling
  tools without reconnecting; operator-kept defs (disabled included) never
  duplicate. Jira scopes already cover it (classic read:jira-work).
- Create tools now tell the model to confirm the filing WITH a clickable
  link (Linear url field; Jira compose https://<host>/browse/<key> from
  `self`). Chat surfaces already linkify markdown + bare URLs.
- Also seen: the model filed JAN-5 AND JAN-6 (dupes) without mentioning
  either. Retest after the nudge: filed JAN-7..10 anyway — incl. "Don't
  forget the peas" as a literal ticket — still unreported. Verdict:
  lite models ignore description nudges on mutations. Resolution:
  jira/linear/github create_issue are now approval-gated (same class as
  the already-gated *_add_comment — catalog flag, operators can't
  un-gate). Zendesk/HubSpot create_ticket left autonomous — filing to
  the human queue IS their product flow.
- No delete tool exists and none should (a visitor nuking escalations);
  Linear's OAuth scope is deliberately read+issues:create so even the
  API token can't delete. Clean up test issues in the Linear UI.
- torontofood's system_prompt now pins project KAN.
- Note for future tool adds: new catalog tools reach stamped installs via
  the backfill — no migration needed — but tools REMOVED from a template
  linger in stored configs (name-merge only adds).

## 2026-11-02h — OAuth wave: all registrations live + provider gotchas
- Every self-serve Connect card is REGISTERED + env'd: Jira, Linear,
  HubSpot (hs CLI, AUP signed, 25-install cap), Salesforce (ECA + PKCE),
  GitHub (org OAuth app, expiring tokens ON), Slack (existing Janis app,
  bot scopes), Confluence (same Atlassian app), Zendesk (local client in
  janis-96119 — global request filed w/ partners@zendesk.com + portal).
- Live-fire learnings: SF ECAs require PKCE (verifier rides signed
  intent v field); Atlassian authorize needs PER-PROVIDER callbacks
  registered + per-product site access (add Confluence product to the
  site); Zendesk granular scopes must match client allowed-scopes;
  slack/github/zendesk tokens are staticToken (stored token serves —
  noRefresh + staticToken BOTH required or mint throws at verify);
  Zendesk needs subdomain-aware tokenUrl (function on intent).
- Mike confirmed all five connects tested/working. Next: MCP client
  (long-tail play, needs identity/approval design for discovered tools),
  Notion (OAuth card first — same machinery; deeper knowledge-source
  sync later).

## 2026-11-02g — Connector wave: GitHub + Slack cards, HubSpot OAuth restored
- github / github-connect cards (PAT + OAuth) — third escalation target.
  OAuth spec: api.github.com on CONN_GITHUB_TOKEN, repo scope. Mike
  registers the OAuth App (Developer settings → OAuth Apps, both
  callbacks) → GITHUB_CLIENT_ID/SECRET.
- slack card — BYO bot token (xoxb-) + channels:read/chat:write scopes:
  slack_list_channels + approval-gated slack_post_message for paging the
  team. Tool templates can't reach workspace slack_installations yet —
  that's the v2 (agent-scoped install → CONN_SLACK_TOKEN).
- HubSpot OAuth card RESTORED after scope research: unlisted
  marketplace-distribution apps install via OAuth up to 25 portals (AUP
  signed = live). Gotchas: 'tickets' scope retired → crm.objects.tickets
  + crm.schemas.tickets; 'oauth' scope required in requiredScopes AND
  the authorize URL. Registration is hs CLI (tools/hubspot-app/ scaffold
  committed): npm i -g @hubspot/cli → hs account auth → hs project
  upload → creds on the project page. Installed app lives under
  developer-projects/<acct>/project/<proj>/component/<app>/distribution.
- card-collapse shipped: ToolTemplateInfo.manual links an OAuth card to
  its credential sibling — one card per provider, OAuth Connect default,
  'Use your own credentials instead' expander for BYO.

## 2026-11-02f — Ask Janis pane: tall-reply top-anchor fires once, not per commit
- The every-commit layout effect in AskJanis.tsx re-anchored to the top of
  a taller-than-pane agent reply whenever `stick` was on — reading a long
  answer to the bottom re-armed the stick, and the next poll tick (3s)
  yanked the pane back to the greeting. `snappedFor` now records the last
  row already snapped so the top-anchor only runs on the delivering
  commit; later commits bottom-snap. Typing-dot rows are excluded from
  "newest message" so their mount/unmount doesn't re-fire it.
- ConversationPage was already correct (every-commit effect bottom-snaps;
  its top-anchor only runs on Jump-to-latest).

## 2026-11-02e — Visitor reply latency: parallel pre-LLM setup + widget SSE
- replyAsHostedAgent + the suggestion path awaited ~11 serial DB/HTTP
  lookups before the first LLM call (transcript, knowledge docs, secrets,
  identity, alerts, saved widgets, campaign context). All but the two real
  dependencies (docs←transcript, secrets←token-refresh) now run
  concurrently — ~one Cloud SQL round-trip each off the critical path.
- New GET /chat/:token/events streams an SSE poke per bus event on the
  visitor's own conversation (payload-free — /messages stays the durable
  read). 404 while no thread exists; resolves identity exactly like
  /messages (claim params, simVisitor, thread key).
- widget.js opens the stream after a poll returns a real conversation,
  drops its interval to 15s while SSE is live, reverts to 3s on any close,
  re-polls on (re)connect to close the no-replay gap, and closes the
  stream on resetTranscript (new chat / participant rebind) since it's
  bound to the old conv id.
- Deferred deliberately: token streaming (guard/regen loop can invalidate
  already-shown text + only webchat could consume it), prompt caching
  (needs stable prefix measurement; billed storage can lose at low
  volume), min-instances (only real $ item, ~$60-70/mo). Bus relay adds up
  to ~500ms on cross-instance events (bus_events POLL_MS).

## 2026-11-02d — One-click OAuth for Jira, Linear, HubSpot, Salesforce
- routes/oauthConnect.ts is a GENERIC connect factory — one pair of
  routes (/api/oauth/:provider/connect admin+bounce; /oauth/:provider/
  callback stateless) serves every *-connect card: consent redirect,
  code exchange, agent_connections upsert, tool install, flash redirect.
  Calendly/Google predate it and keep their own routes; new providers
  are a config entry, not a file.
- connections.ts grew three ProviderSpec knobs for auth-code providers:
  refreshBody (client_id/secret in POST body — Atlassian/HubSpot/SF,
  vs refreshBasic's Basic header), jsonToken (JSON body — Atlassian),
  exposeSecrets (creds fields → CONN_<P>_<FIELD> secrets for tool URLs).
- Provider quirks encoded: Jira 3LO calls api.atlassian.com/ex/jira/
  {cloudId}, never the site host — cloud_id is captured from
  accessible-resources at callback; Linear runs actor=app so issues
  post as the app; Salesforce's instance_url from the token response
  is the API host; salesforce provider spec now branches — OAuth rows
  (refresh_token) mint on login.salesforce.com, BYO rows (client creds)
  keep their instance host.
- Four new cards: jira-connect / linear-connect / hubspot-connect /
  salesforce-connect — tools cloned from the PAT cards (same names,
  identity/approval flags carried) with CONN_* auth + host swaps.
- Web flash list in AgentDetail is now provider-keyed (was hardcoded
  calendly/google).
- Cards show "not configured" until env lands — Mike registers four
  self-serve OAuth apps (all free, instant, no review): Jira → dev
  console OAuth 2.0 app + Distribution toggle ON, scopes read:jira-work
  write:jira-work offline_access; Linear → Settings→API→OAuth app,
  read,issues:create,comments:create; HubSpot → free developer account
  public app, contacts read/write + tickets; Salesforce → connected app
  in any org (free DE org works), api + refresh_token scopes. Redirect
  URI for all: https://api.janis.ai/oauth/<provider>/callback.
- Zendesk deliberately skipped — real OAuth needs a global client =
  partner approval; the BYO client-credentials card stays.
- PKCE: Salesforce External Client Apps REQUIRE code_challenge (the
  first connect 400'd missing required code challenge) — spec.pkce
  sends it; the verifier rides the signed Intent (v field), no server
  storage. Other gotchas learned live: SF consumer keys take ~10min to
  propagate; Jira consent 403s when the Atlassian account has no Jira
  site; Linear app defaults "Private to this workspace" (flip for
  customer installs); HubSpot moved app creation to the hs CLI and
  gates public installs behind marketplace review — PAT card stays
  primary there.

## 2026-11-02c — Jira + Linear tool templates (issue-tracker escalation)
- Two new cards in toolTemplates.ts ('Issue tracking' category): jira
  (search / get_issue / create_issue / add_comment) and linear (teams /
  search_issues / get_issue / create_issue / add_comment).
- Reads are identity-bound AND mechanically scoped, not just described:
  jira_get_issue composes `key = "X" AND (text ~ "email" OR reporter =
  "email")` server-side; linear_get_issue filters `number eq N AND
  description contains email`. A public widget can't enumerate internal
  tickets — the ticket must reference the verified customer or the
  lookup returns nothing.
- Creates embed the verified email on the ticket itself (Jira ADF first
  paragraph, Linear description prefix) — that closes the loop so the
  scoped reads find Janis-filed issues later.
- jira_add_comment / linear_add_comment are approval-gated (mutate an
  existing ticket → teammate approves), same posture as Stripe writes.
- Gotchas encoded: Jira legacy /rest/api/3/search is REMOVED — must use
  /search/jql (jql+maxResults+fields params, nextPageToken paging).
  Linear personal keys go in `Authorization:` RAW — no Bearer (Bearer is
  OAuth-only). GraphQL bodyTemplates need the ${…} form + a ${noop?}
  pad var or {word} inside selection sets gets read as placeholders.
- Next connector lever (agreed with Mike): MCP client > Jira/Linear
  (done) > Notion knowledge source > Freshdesk; ~20 Fin tiles are MCP
  long-tail, not bespoke work.

## 2026-11-02b — Cross-account deep-link leak fixed (sign-in landed on a foreign agent)
- Reported: signing in as google-review@janis.ai loaded
  /agents/fae34af5-…?rail=ask — an agent in a DIFFERENT workspace ("Agent
  not found"). Root cause is storage being per-origin, not per-account.
- post-login-next (RequireAuth stash → Layout replay) carried no identity:
  a 401 on an agent page stashed the URL, and whatever account signed in
  next replayed it. The stash is now {next, u, w} — user+workspace ids
  persisted to localStorage janis:last-identity by useMe — and Layout
  replays only on an exact match. Legacy plain-string stashes drop.
- Login.tsx empty-inbox fallback read janis:last-agents via
  Object.values(m)[0] — literally any workspace's pick. Now keyed by the
  signed-in workspace (lastAgentId) and validated against /api/agents;
  invalid/missing → /welcome as before.
- Follow-up (same day): the bad landing was self-perpetuating — a 401 on
  the foreign-agent URL re-stashed it under the user's OWN identity, which
  the first fix replayed. postLoginTarget (agentContext.ts, unit-tested)
  now also requires the /agents/<uuid> target to exist in the workspace's
  agent list, and useAgentContext bounces a settled-foreign uuid param to
  /conversations instead of persisting it — isFetching gates the
  just-created-agent race, /agents/new/<id> exempt.
- Third report ("delete agent → sign out/in → Agent not found once, then
  clean") was the PWA precache serving the PRE-fix bundle — verified
  end-to-end via scripts/ui/deleted-agent-landing.mjs (Playwright: visit→
  delete→stash→sign-out→real sign-in — every vector drops). Root systemic
  fix in main.tsx: controllerchange → one reload, so the load that
  discovers a new SW also runs the new bundle (first-install exempt —
  nothing stale was ever served). Without it a long-lived tab can run a
  pre-fix build for a full extra sign-in cycle.
## 2026-11-01e — Composer consolidation: always-up box, Pause ⇄ Resume toggle, send-as popover
- The ops row (Take over / Reply as agent / Internal note / Teach / Archive /
  Delete) is gone. The composer always renders for non-archived threads —
  mode pick lives in its reply-as dropdown, Archive/Unarchive duplicates the
  Status dropdown, and Delete moved to a card at the bottom of the details
  rail. Archived threads show a muted "Archived" label only.
- The toggle next to Send flips on `state === 'human'`: "Pause" (takeover —
  pauses the agent immediately, pre-typing) ⇄ "Resume". Words stay visible
  at every width (.btn-label.always beats the hide rules by specificity);
  under conv≤560 the ICON drops so the word alone keeps it unambiguous —
  icon-only ⏸ reads as state OR action, which are opposites.
- API: humanReply no longer 409s "take over the conversation before
  replying" — a human send IS an implicit takeover (takeover.ts runs the
  same path: state→human, assignee, Meta thread control, transcript note).
- Send-as picker: the invisible native <select> let the OS draw its menu
  anywhere (mid-transcript on phones). Now a ModeIcon button + a custom
  .emoji-pop-style popover (.sendas-pop, 240px) anchored above the
  composer; Esc/outside-click close with the other pops. Labels are
  verb-first and match the placeholders ("Reply as yourself", "Leave an
  internal note", …) and placeholders now say what each mode does.
- Ops-button labels: btn-label hiding moved from conv≤780 to conv≤560 —
  780 was stripping words at exactly the widths dock-open leaves the
  column. The viewport-proxy `.layout.dock-open` media rule that did the
  same is gone; the conv container query is the real gate.
- Why-this-reply inspector: the 20 knowledge snippets used to dump full
  chunk bodies — now collapsed behind <details>, counts/tools/model
  up front. (True per-chunk attribution isn't introspectable; the honest
  view is "available context" + actual tool calls.)
- All on janis-api-01323-fgj @ 100%.
## 2026-11-01d — Details card leads the rail again; controls lead only in drawers
- d1e2c33 had moved Status/Assign above Details for phone triage but it
  reordered the desktop rail too. ConversationPage DOM is now Details →
  Status → Assign; the two slide-over contexts (convl≤680 container query
  + phone media query) re-order .conv-side-status/.conv-side-assign above
  Details via flex order — claim/status still leads on a phone.
- Same push earlier: copilot prompt — the `page` trait is the operator's
  live page (restamped every message) and no-arg read_conversation /
  lookup_contact resolve it; janis pack relabelled "Operator context" so
  the model stops calling the operator the viewed thread's customer.
## 2026-11-01c — Context switcher keeps the current surface across scope picks
- Picking an agent / "All agents" used to always land on `/agents/:id`
  overview or `/conversations`. Now `contextSwitchTarget(pathname, agentId)`
  in agentContext.ts maps the landing: shared pages (Inbox/Contacts/
  Campaigns/Reports) re-scope to the same section, agent sub-pages swap
  the id (`/agents/A/settings` → `/agents/B/settings`), and entity detail
  (a selected conversation/contact/channel) drops to the section root —
  the id can't cross into another agent's scope. Scoping OUT to
  all-agents keeps the open entity. Layout's onGo clears last-agent on
  any non-/agents/* landing, not just /conversations.
## 2026-11-01 — Open alerts render inline in the transcript as dismissible warn boxes
- ConversationPage: the stacked top alert card (⚠ type — detail + Dismiss
  per row, duplicated the flagged blurbs it summarized) is now a compact
  chip strip (type only). Chips scroll to the blurb via the existing ?msg=
  deep-link/msg-hit machinery.
- Each open alert anchors to the transcript row its event wrote — flagged
  system lines (help_request/failure/handoff_offer/custom), internal
  rule_trigger notes (sla/inactivity/keyword/intent/sentiment/error/csat,
  matched by detail substring + closest ts), or the pending-approval card
  (approval_request — warn border only, its own Approve/Deny resolves it).
  Unanchored alerts render a synthetic warn box sorted in at created_at.
- Dismiss unwraps the box; the blurb stays (and the API's alert_status
  note records who resolved it). ALERT_LABELS exported from Layout.tsx.
## 2026-11-01b — Copilot full context: view-resolution + visitor traits + clean context block
- lookup_contact/read_conversation args now OPTIONAL: omitted, they resolve
  the operator's current page (`userProfile.metadata.page` — /conversations/
  <id>, /agents/<id>/inbox/<id>, /contacts/<id> parsed by currentView()).
  "this conversation / this user here" works instead of the model
  transcribing a uuid — it guessed wrong twice in prod (conv 79391949 was
  in the page trait the whole time).
- visitorContext(): both tools return the conv's visitor block — name/email,
  identity_verified + janis_user_id, and the full trait bag (signed-in Janis
  users carry their console context: agents, workspaces, page). "What are
  Loan's agents" answers from conversations[].visitor.traits.agents.
- Disambiguation/not-found are RESULTS, not failures: {"result":
  "multiple_matches"|"not_found", hint, matches} — the {"error" shape marks
  outcome 'failed' and fires a Run-error alert for a perfectly good search.
- conversationContext() sanitizes the janis console pack for display:
  <uuid> decorations + (kind:uuid) groups stripped, bare uuids → '…',
  agent lists render comma-separated names. Ids are NOT lost — tool results
  carry them verbatim (traits cap 6000 for janis packs), and the link guard
  verifies console urls by DB row not prompt-verbatim. Copilot preamble
  updated: "resolve the id you need through a tool".
## 2026-11-01 — Copilot can answer "who is this customer" — contact + transcript tools
- Two new concierge builtins (builtinTools.ts): `lookup_contact` finds a
  person in the visitor's workspace by name/email/phone/tag/id and returns
  the full contact record — channel identities, tags, notes, traits,
  external CRM ids, plus every linked conversation with console links;
  `read_conversation` resolves a thread by UUID or customer name/email/
  phone and returns state/agent/channels/assignee/intent/sentiment, the
  linked contact card, and the latest transcript. Both read-only,
  member-level, same signedInUser + visitorWorkspace gating as the other
  copilot tools; merchant-Ask picks them up via copilotBuiltins().
- `findVisitorConversation` now also resolves through the contact record —
  a name/email/phone search finds conversations whose own userProfile is
  anonymous (the contact_id link is the only attribution), so
  debug/teach_from/assign_conversation got the tie for free.
- DRIFT WARNING honored: `scripts/tmp/enable-contact-tools.ts` appended
  both names to the concierge agent's config.builtin_tools in dev AND prod
  (idempotent — re-runnable after future concierge-tool additions).
## 2026-11-02 — Details drawer actually hides; conv column clips the rail
- `.conv-layout` gained `overflow-x: clip` (hidden fallback): the closed
  details drawer is `position:absolute; right:0; translateX(105%)` inside the
  column — without clipping it still PAINTED over the Copilot dock, which is
  what "details view can't be seen in full" was. Now closed = truly
  invisible; the ⓘ button is the only way in. Drawer stays scoped to the
  conversation column (never covers the dock), scrim dismisses. Same clip
  covers the phone media drawer and the convl≤680 container-query drawer.
- Preceded in the same push series: dock-open ≤1400 makes the rail the ⓘ
  drawer (never stacked under the transcript), the drawer anchors to
  `.conv-layout` not the viewport, `.info-btn` hides whenever the rail is in
  flow (was losing specificity to `.conv-actions button.btn`), snooze-moon
  icon fixed (base `display:none` sat AFTER the container query — container
  queries add zero specificity, so later-same-specificity wins; base rules
  for icon states must be declared BEFORE the query overrides).
- Saved views folded into the filter sheet; funnel badge counts selected
  filters; attention preset = needs_human+human OR has-open-alert (matches
  the orange dot); negative_sentiment SIGNALS option; tag search;
  handoff offers auto-dismiss on non-accept replies + a sla_minutes-aged
  sweeper backstop; bulk bar = count/close row + 5×2 action grid + sticky
  "Select all loaded"; bulk delete added (same cascade as single delete).
## 2026-10-31 — Landing wave 2 + video loop + widget double-mount fix
- DemoStrip is scenario-switchable (Shopify/Stripe/Zendesk/Cal.com/HubSpot
  chips swap the played beat); hero + feature groups now carry REAL console
  screenshots staged on curated janis_dev data (Hair Salon Concierge,
  fictional customers, teammate "Ava Chen", live approval card).
- Hero shot is now an 8s muted looping mp4 of the live console
  (marketing-approval.mp4, poster fallback to the still).
- FIX: widget.js executed twice when a host mounted the script tag twice
  (StrictMode effect replay) → stacked bubbles/panels, dismiss toggled the
  hidden instance. `window.__janis_booted` guard at eval + reset in
  destroy(); landing ?v bumped to 4.
- BUG FIXED 2026-11-01: decidePendingAction on a CUSTOM http tool crashed —
  `Cannot read properties of undefined (reading 'matchAll')`. Root cause was
  NOT the identity boundary scan: the parked action's stored tool snapshot
  was a thin {name, description}, the TOOL_TEMPLATES backfill can't resolve
  custom tools (not in the catalog), and callTool threw on
  `undefined.matchAll` in the secrets scan. Fix: decidePendingAction resolves
  the def from the agent's live config via toolsFor before the catalog
  fallback and records a clean "no endpoint configured" error when nothing
  resolves; callTool degrades malformed defs (missing url, string headers)
  to error strings; toolsFor parses string params/headers + a "body" alias
  for bodyTemplate (operator-authored config JSON); widgetDigest's
  toolDef.url scan got the same guard. Regression tests in
  approvals.test.ts (partial-snapshot resolve + unresolvable-tool error).
  Verified e2e on janis_dev — fresh thin-snapshot approval on the salon
  conv executes the live def. Also flipped the seeded issue_refund's method
  to GET in janis_dev (it POSTed to the GET-only /health → 404; the seed's
  params/headers/body fields were hand-written strings, now normalized by
  toolsFor).
- Deployed through janis-api-01265-jl4.


**Mobile conversation + inbox pass (Oct 31):** second wave on the phone
surface. `.conv-open` is truly anchored — `.main` locks, the head/actions/
composer can't shrink, and stacked cards cap at 32vh so a giant alert
can't push the transcript + composer off-screen (was: page clipped,
nothing reachable). Details live in a ⓘ-opened right drawer ordered
Status → Assign → Details → Intent/Tags → Customer; the header's state
badge opens it. Operator actions and inbox chrome are icon-first
(`.btn-label` spans hide ≤720): snooze + reply-as selects get icon faces
(`.snooze-wrap`/`.sendas-wrap` — invisible select over a glyph showing
the CURRENT value), suggest-reply moved into the composer bar, and
composer placeholders go terse via matchMedia. Inbox header collapsed to
one row: All / attention-icon(+count via useAttentionCount) / funnel /
AgentScopePicker, search last via flex `order`; onboarding cards,
select-all row and keyboard hints hide on mobile. Sheet dismissal model:
a scroll landing on a sheet backdrop folds it while the gesture keeps
scrolling the page (document-level touchmove/wheel → el.click(); modals
still lock `.main`). Two scroll bugs fixed: scroll-chaining under
backdrops, and `snapToBottom` on image load no longer calls
`snapToLatest`'s tall-inbound top-anchor — pinned readers at the bottom
were being yanked to the top of the last message (top-anchor survives
only on explicit jump-to-latest).

**Mobile scroll/icon audit round 2 (Nov 1):** conv footer is now truly
anchored — .conv-foot sticky-bottom under @container conv (≤780px),
opaque bg, margin-top:auto inside a definite-height chain
(.layout.conv-open .main flex-column → conv-layout flex:1 → conv-main
min-height:100%), so it holds bottom on short AND long threads. Inbox:
.conv-list is the scroll region at every width (.main locks via
.layout:has(.inbox-head)); DiscoveryCards/Onboarding render only when
the inbox is empty (force prop kills the "Take a tour" stub). Buttons
iconify by COLUMN width — .conv-main is a @container conv (≤780px);
the ≤1100/dock-open viewport rules remain as fallback. The ≤900
transcript 55vh cap was removed (nested scroller). Dock reflows at
≥960px (was 1200) — no more .test-dock-dim wash; conv-side stacks
below transcript when dock squeezes 721–1500px.

**Landing wave 2 — demos + real screenshots (Oct 31):** per Josh Barkin's
feedback (shared via iMessage — taken as direction, not gospel): DemoStrip
is now data-driven — a `.demo-chip` row (Shopify, Stripe, Zendesk,
Cal.com, HubSpot) replays the approval flow with that stack's tool call,
args, and outcome copy (`SCENARIOS` + `beatsFor()`; `demo_scenario`
analytics event). Hero is no longer text-only: a real console screenshot
(`marketing-console.png`) sits framed like the demo windows. Each feature
group now shows a real product screenshot above its cards —
`marketing-inbox.png` (Hair Salon inbox, pseudonymous visitors),
`marketing-tests.png` (scenario suite w/ EXPECTED/REPLIED/WHY-IT-FAILED),
`marketing-reports.png` (AI-vs-human split). Shots captured from janis_dev
clipped to `.main` via playwright (temp admin membership added+removed —
that workspace isn't admin's). Comparison table gained 'Integrations:
read-only lookups → read and write'. Still owed: testimonials, logo wall
(#36), real brand logos on the demo chips if we want them.

**Landing page revision pass (Oct 31):** `Landing.tsx` rewritten to match
the shipped product — the flat 8-card feature grid became four themed
sections: "One front line, every channel" (inbox now lists Gmail/Outlook
shared inboxes; help-center card; personas folded into takeover), "An
agent that gets safer every week" (approvals, rescue→replayable-test with
simulated teammate + run diffs, prompt conflict-audit/rewrite/version
history, site-crawl + private Google-file knowledge), "Run support like a
system" (campaigns, reports/CSAT/conversions, contacts+CRM sync), and
"Bring your own — agent, bot, or model" (npm SDK/webhook, Chatfuel/
ManyChat ingest, BYOK $0 LLM line). Hero gives hosted and BYO equal
billing instead of treating hosted as a footnote; steps/comparison table
(updated 'Your agent' + new 'Changing the rules' row)/integrations
(Salesforce, Calendly, Google Drive, Slack, Make)/FAQ (Google Docs Q,
bot-ingest answer) all refreshed; pricing intro notes Scale's SSO/SCIM +
GDPR export. Eight new inline stroke glyphs (book, shield, refresh, send,
chart, users, bot, key). Still owed: real screenshots + proof assets
(AGENTS.md #36).

**Slack-style mobile shell (Oct 31):** at phone width the console spent
~110px on a dead icon rail + dock strip. Now: `.sidebar` becomes an
off-canvas drawer (full labels) behind a sticky `.mobile-bar` (☰ + the
dock strip's icons) at ≤720px; `.nav-scrim`/Esc/nav-click/route-change
close it. Conversation routes (`.layout.conv-open`) hide the bar and own
the screen — `.conv-mobile-head` (back chevron → `navigate(-1)`, falling
back to the owning inbox on cold opens + avatar/name/channel/state) and
`.conv-actions` collapses utility buttons to icons (`.btn-label` spans).
`.dock` went full-screen ≤720 (was 640); `/ask` hides `.main` and gets a
`dock-back` chevron in place of the minimize glyph. Audit fixes folded in:
literal `&amp;` in AgentDetail credentials title (JSX string, not decoded),
`.ov-cols`/`.ov-side` stacking on AgentOverview (was ~50px for recent
conversations), `.chan-row` names crushed to one char, Contacts search
`.contacts-search` flex-basis 100%. `scripts/ui/mobile-audit.mjs` drives
the whole console at 390×844 and reports scrollWidth overflow.

**Loose lists keep their numbering (Oct 31):** agent replies rendered every
numbered step as "1." — `splitBlocks` flushed the list at each blank line,
so a model-style loose list (`1. …\n\n1. …`) became N one-item `<ol>`s that
each restarted at 1. A blank line inside a list now pauses it: a same-kind
marker continues the list (flagged `loose` → `md-loose` CSS for item
spacing), a different marker kind or a paragraph ends it. Applies to all
`splitBlocks` surfaces: inbox transcript, Ask Janis rail, Shopify app.

**Link guard learned help-article slugs (Oct 31):** the concierge cited a
published help article (`/help/<agent>/<slug>`) verbatim from its knowledge
context and the link guard stripped it as a non-route — `consoleSlots` only
knew `/help/<uuid>` and `/help/<uuid>/<uuid>`, while real permalinks key on
the slug (routes/helpCenter.ts `/api/help/:agentId/:articleId` accepts
slug-or-uuid). Surfaced as "Run error — link guard stripped 1 URL(s)" on a
rule-trigger run right after the WEB_ORIGIN flip to www.janis.ai moved help
URLs onto a console host. Fix: `consoleSlots` accepts a slugged third
segment and emits an `article` slot; `consoleIdChecker` resolves it
slug-or-id under the claimed agent, published-only (the public surface 404s
drafts); and a console URL matching a blessed URL verbatim (origin+path —
the corpus wrote it) now skips structural judgment entirely, which covers
test-channel draft citations and any future route shape.

**Concierge KB + help-center refresh (Oct 31):** concierge-kb.txt grew
129→144 entries covering everything shipped since the last pass —
Chatfuel/ManyChat bot channels (ingest URL, ~15s sync window, human
takeover silences the bot, PSID thread-sharing with Meta surfaces,
{{directives}}, secondary receiver), the four Google tool cards +
private-Google-URL knowledge sources, Check-for-conflicts + Suggest
rewrite, instruction/article version history, run-history diff, SMS
double opt-in, contact consolidation, named API keys, the /v1/knowledge
endpoints, widget new-chat/suggested-articles/Text-us, neural voice.
Prod synced via sync-concierge-kb.ts (persona unchanged). The concierge's
public help center (14 stale Sept-29 articles) got 9 body rewrites —
what-is-janis and connecting-channels wrongly listed Slack as a customer
channel — plus two NEW articles: bot-platforms and google-tools.
Old bodies snapshotted into help_article_revisions first (stamped at the
article's updated_at) so history shows both sides; done via the gitignored
scripts/tmp/update-help-articles.ts.

**Google card Add drops straight into the Drive picker (Oct 30):** adding
Sheets/Docs/Slides/Drive on an already-connected account installed the
tools but left the card fileless — the tools can't act until a file is
shared, and finding "Pick files…" was on the operator. The install
mutation's onSuccess now runs the card's own `openGooglePicker(t.id)`
when `GFILE_MIME[t.id]` matches (the four google-* templates), so the
next click is the file. Verified in-browser end-to-end (dev): copied a
prod `agent_connections` google row into janis_dev (same
JANIS_SECRETS_KEY → creds decrypt; GOOGLE_CLIENT_ID/SECRET in dev .env
mint the refresh — deploy overlays .env under .env.production, so prod
uses the same client), plus GOOGLE_API_KEY + GOOGLE_PICKER_APP_ID copied
.env.production → .env (needed locally; unchanged in prod). Caveat: the
Google Picker iframe shows a sign-in wall on localhost:5173 — that
origin isn't a registered JS origin on the OAuth client; prod origins
work. Removing the last google-* tool GCs the connection row
(gcUnusedConnections) — re-copy when resetting test state.

**Instruction-card Save + error/display fixes (Oct 31):** the shared-draft
Save also lives on the Instructions card header (form got long), and saves
now invalidate instruction-revisions so Version history refreshes without
a reload. Two display fixes: ApiError stringified structured error bodies
to "[object Object]" (now falls back to body.message/HTTP status — that
was the red text in the diagnose card), and the conflict Apply state
resets on each Check-for-conflicts run (index-keyed marks bled onto new
results). Deploy gotcha worth remembering: gcloud's default project is
jottogame — `gcloud run revisions list` without --project shows another
service's lineage and makes a good deploy look absent; and the app is a
PWA — a stale service worker serves the old bundle until a hard refresh.

**Conflict fixes are apply-able; version history is visible (Oct 31):**
each prompt-check conflict can carry {field, find, replace} verified
server-side against the real text — an Apply fix button lands it as a
draft edit for normal Save. Version history now always renders (it hid
under 2 revisions and looked absent) with honest coverage copy, and
snapshots tone too — agent_instruction_revisions.tone added (migration
0123; pre-tone rows restore keeping current tone). Knowledge notes and
procedures still aren't versioned — the remaining gap.

**"Check for conflicts" — rule-contradiction audit (Oct 30):** the concierge
deflected a "speak to a human" request to sign-in because two authored rules
collided ("flag for a human when asked" vs "manual intervention → sign in
via Copilot") — invisible until a regression test failed. POST
/agents/:id/prompt-check reads the rule surface the way the model does
(instructions + tone — accepts in-flight text — plus always-injected
knowledge notes, procedure triggers, and the platform persona/context
lines) and returns colliding pairs {a, b, when, fix}. The Instructions
card has a Check-for-conflicts button rendering the pairs + suggestion.
checkPromptConflicts lives in lib/agentTests.ts. Oct 31 deepened it:
findings now carry kind (conflict | redundant), severity, a "why"
sentence, and apply is a LIST of find/replace edits (delete = empty
replace, multi-directive fixes — verified all-or-none: any find that
doesn't locate verbatim drops the whole set rather than half-applying);
no-apply findings say "no one-click fix" instead of silently lacking the
button. New POST /agents/:id/prompt-rewrite + "Suggest rewrite" button
proposes a consolidated full-instructions rewrite (preserve every rule,
merge dupes, never import platform-injected lines) that lands in the
draft textarea for review — saves stay on the normal flow. The concierge
persona itself got the same treatment (scripts/concierge-persona.txt):
the unconditional "list data categories instead of offering a handoff"
and "specific realistic timeframe" lines were removed — handoff now
explicitly wins, no invented SLAs, and approval-card retries require an
actual error (a blind re-call double-posts the proposal). Oct 31 cont.:
Apply fix now auto-saves and re-runs the audit so the next finding is
ready to click through; the instructions textarea is user-resizable; and
a second-pass verifier (CONFLICT_VERIFY_SYSTEM — judges each claimed
finding's triggers, axis, stated precedence, and coherence) drops
false-positive pairs like "flag a human" vs "sign in for account work"
(server returns {conflicts, dismissed}; the UI reports the count).
Generation stays deliberately high-recall; verification fails open.
Also fixed at the source: the platform sign-in line now states
escalating to a human isn't workspace-bound (hostedAgent.ts). The
Suggest-rewrite side got the same treatment: rewritePrompt is now
findings-aware (the latest check results steer which pairs merge),
reorganization-not-reauthoring (no invented conventions — it had been
inlining procedure summaries as "ask for order number"), and a second
REWRITE_REVIEW_SYSTEM pass diffs the proposal against the source so the
card lists dropped/added rules with quotes before Use-this-rewrite —
silent flattening became a reviewable report. The rewrite's ruleSurface
hides knowledge/procedure CONTENT (fields named, text withheld) — can't
inline what it can't see.

**Test sims understand human handoffs (Oct 30):** rescue-saved tests replayed
without the conversation's escalation state — the synthetic conv carried
profile/channel/summary but not `state`, so the prompt never got the "a
human was already notified — keep helping" line, and a customer re-pinging
after handoff met an agent that re-offered a human who was already coming.
Drafted expectations also asked for what a sim can't produce (a real ETA,
a human acting). Now: ReplayContext snapshots conv.state, runs derive
needs_human/pending-offer/operator-spoke from transcript markers (older
saves, bare-turns tests), transcriptTurns drops internal audit rows
("Assigned to…", "Status:", "SLA breach") like transcriptFor does — stored
turns are cleaned by mid lookup (or known note shapes when the source row
is gone) at run AND read time. An escalating run (fresh [HANDOFF] or an
already-escalated transcript) conjures a simulated teammate reply —
last_run.humanReply, rendered as "Simulated teammate" on the row and
shown to the judge — so scenarios spanning a human stay testable. Drafter
+ judge prompts learned sim limits; POST
/agents/:id/tests/:testId/expectation-redraft + a Re-draft button on
AI-draft rows rewrite a bad bar and re-judge the stored reply. Live
prompts also gained the "(human operator) turns are a teammate's words,
not yours" line (humanSpoke opt).

**Widget round 3 — blank transcript after Start a new chat:** menuNew's
manual reset wiped the DOM but left `state.greetEl` pointing at a
detached node; the fork's stored greeting row adopted into it via the
`m.greeting` dedupe and rendered nothing (blank thread). Now calls
`resetTranscript()` (clears greetEl/typingEl/qrsEl/outbox/deliveredEl).
The bootstrap greeting block also gated on a fully-empty transcript —
but /new pre-stores the greeting row, so quick replies/help suggestions/
greeting widgets never rendered on a fork. Greeting-only transcripts now
count as empty (stored row adopts into the synthetic greetEl). Embed
bumped to `/widget.js?v=3`.

**Widget menu redesign + follow-ups (Oct 30, second pass):** "Start a
new chat" is now ALWAYS in the ⋯ menu — ending is a consequence, not a
prerequisite (Intercom's model; Mike asked). `/new` archives a live
thread via the shared `endConversation` helper (covers human-owned) then
forks + upserts the binding. "End chat" shows only while something is
live; starting fresh over a live transcript window.confirm()s since the
old thread leaves view. Suggested-articles toggle actually saves now —
`show_help_suggestions` was missing from the Channels.tsx PATCH payload
(toggle flipped, never persisted; Mike's concierge channel flagged off
in prod). `widget.js` gets stale-cached an hour on www — the CF
janis-legacy-proxy worker forces `cache-control: max-age=3600`
regardless of origin (origin emits 300). Landing.tsx now loads
`/widget.js?v=2` — bump the version on widget behavior changes or
visitors run the old JS for an hour post-deploy.

**Widget end/new-chat fixes (the stuck ⋯ menu):** `/chat/:token/end|new|
typing` never forwarded the signed identity claim, so an identified
visitor's actions resolved the anonymous participant — `/end` faked
'archived' on a conv it never touched, the poll reverted convState, and
the ⋯ menu stayed on "End chat" forever. `/new` also updated (not
upserted) the channel binding — a missing row (dies with an
inbox-deleted conv, or never existed via the `u:` externalId fallback)
meant every "Start a new chat" minted an orphan `…#<ts>` fork while the
visitor stayed anchored to the archived base conv. Fixed: shared
`visitorAction` schema carries the claim, `/end` reports real state and
archives even `human`-owned threads (customer leaving wins over the
operator-close rule — runs applyConvEffects for CSAT/hooks/Meta
release), `/new` upserts the binding, widget.js sends the claim on all
three calls, only draws the ended note on a real `archived` response,
and offers "Start a new chat" whenever the ended note is rendered.

**Bot-platform contract completed:** `lib/botPlatform.ts` is the single
response builder — `buildBotResponse(flavor, {text, quickReplies,
widgets, attachments, effects})` drives both the sync card reply and the
ManyChat sendContent push. Cards/widgets/images now render on
Chatfuel/ManyChat (generic-template/cards per legacy shapes), and a
closed `{{…}}` directive grammar the prompt teaches only on bot-channel
convs (hostedAgent fragment) maps to platform effects: `{{set f=v}}` →
set_attributes/set_field_value, `{{goto "F"}}` → redirect_to_blocks /
send_flow (pushed via the sendFlow endpoint), `{{tag}}/{{untag}}` →
add_tag/remove_tag (ManyChat). Directives are stripped at `message_out`
store time in ingest.ts (keyed on `chatfuel:`/`manychat:` externalId),
stored as `payload.effects` + human `channel_effects` labels, so
transcripts stay clean. Inbound card attrs merge into
`userProfile.metadata.bot_attrs` — subscriber custom fields ⇄ agent-
visible traits. qrTitle moved to legacyFormat (import-cycle fix).
`formatForChannel` now runs on card text (no more literal `**bold**`).
Operator guide gained full Chatfuel + ManyChat sections (/docs?guide=
operator#chatfuel|#manychat) — setup→testing→advanced→takeover→
troubleshooting, hash-anchored, linked from the channel pages.

**Google-file URLs as knowledge sources + scope re-add:** pasting a
private Doc/Sheet/Deck/Drive link into Teach it now fetches through the
agent's Google connection (new `lib/googleSource.ts`) instead of the
anonymous export crawl that 404s on non-public files. Docs/Slides text is
flattened from textRuns, Sheets render per-tab via values.batchGet, and
opaque drive/file links probe metadata → each native API → binary download
(picked files, extractKnowledgeText). Falls back to the public export
crawl when there's no connection; the google error names the fix ("share
with X / pick it"). SCOPES re-added `auth/documents` (Google OAuth review
had flagged it — Mike chose justification over dropping) and added
`auth/presentations.readonly` (minimal for decks; create stays under
drive.file). Consent-screen + KB-paste flows are the verification demo.

**Bot-platform ingest parity + setup docs:** `POST /bot/:key/{chatfuel,
manychat}` now covers the legacy doc contract end-to-end. Event-only
posts (`{{event}}`/`dfEvent` with no typed text) reach the agent as
`[event] NAME` and open new convs with the greeting (postback semantics,
same as Meta Get Started). Replies split at the 640-char card cap
(shared `splitResponse` from legacyFormat), and stored
`payload.quick_replies` map to platform quick replies — Chatfuel taps
set `user input` + redirect to the `Janis` block, ManyChat emits v2
`node` targets. `manychat_token` (PATCH `/api/channels/:id`, exposed
only as `meta.manychat_connected`) enables api.manychat.com sendContent
pushes — a token'd channel OWNS delivery so the card response stays
empty (no doubles); token-less channels keep the sync response path,
and Meta-bound convs (family merge) already deliver via Graph.
sendChannelMessage no longer stamps a bogus "no access token" delivery
error on bot channels — they return null (pull) like webchat. Channel
pages now carry the full Chatfuel JSON-API-card and ManyChat
Default-Reply/Dynamic-step setup instructions + the token field.

**Ops drills (both closed):** Neon PITR rehearsed — scratch branch from a
past timestamp verified row-count + newest send vs prod, then deleted;
the runbook in AGENTS.md is now proven. k6 load test vs prod: ~150rps
read-only, ZERO 5xx, p95 486ms — the 429s were per-IP rate limiting
working as designed, not a capacity wall. `scripts/load-test.js` gained a
PUBLIC_CHAT_ID widget-bootstrap target.

**Concierge hardening:** anonymous visitors get told up-front they aren't
signed in; `error_reports` gated on `signedInUser` (was the only
ungated operator tool — verified never hit by an anonymous thread); and
the bigger fix — `enabledBuiltins(enabled, workspaceId, verified)` now
scopes the tool CATALOG by conversation identity, so unverified visitors
on the operator workspace see only `publicAnon` tools (web_search,
web_fetch). Fail-closed default.

**Voice/SMS plan gating:** the free-plan upsell never fired because
`useBillingStatus` typed the response as `{ plan }` but the endpoint
returns `plan_key` — fixed; free workspaces now get a lock-icon tab,
dimmed disabled fields, and a visible paid-feature notice. Hosted SMS
confirmed working via the voice channel's subaccount (same number).
A2P 10DLC CLEARED 2026-11-03 — LOW_VOLUME campaign approved, master
number +16506677708 in service MG68b89899…, test send delivered
(see AGENTS.md backlog item 5). Hosted SMS provisioning shipped the
same day: `hosted: true` sms channels buy the number on the master
account + enroll it in the A2P service (subaccount numbers can't
join — forced design, no per-channel subaccount like voice).

**Hosted chat links:** every Bubble channel now gets a shareable
`{apiOrigin}/chat/{id}/page` link ("Open chat as a customer ↗") even
without a widget_domain, plus a `hosted_chat_open` GA4 event on click.

**Console UX:** search now covers archived + snoozed conversations by
default (Slack semantics — archive is a list-view concept); explicit
state filters still scope. Admin "Delete" button on conversation detail
wires the existing DELETE endpoint through the styled confirm dialog —
real erasure for test threads/GDPR where archive can't serve.

**Integrations API:** `GET /v1/knowledge` + `POST /v1/knowledge/:fileId/
refresh` (agent-key authed, agent-scoped, idempotent) — external systems
(Shopify webhook → Zapier → Janis) can trigger an off-cadence re-crawl;
a failed crawl degrades rather than evicting last-good. Docs recipes
updated.

**Depth tails closed:** eval run-diff in Tests → run history (flip
badges + expandable before/after replies — one view serves regression
hunting AND the A/B 'Try a variant' model compare; /test-runs returns
reply text). Help article version history (help_article_revisions,
snapshot-on-save, editor-stamped, restore w/ slug re-dedupe). Widget
suggested-article cards under the greeting (top-3 viewed published
articles, empty-transcript only, `show_help_suggestions` toggle —
separate from the footer link after Mike flagged it). And the same
version-history pattern for agent INSTRUCTIONS —
agent_instruction_revisions snapshots system_prompt/greeting/
quick_replies on every content-changing config save, with a
collapsible history + admin-gated Restore in the Instructions card.

**Meta entity discovery (tracker 15b):** the Janis Meta app's business
verification + Tech Provider status + the FB page all anchor to Josh
Barkin's entities (Stagename Inc., "Josh Barkin's Business") — not
Janis's legal entity. Target: Tangerine Torpedo LLC (Mike's, verified,
already lists janis.ai). Migration steps written into AGENTS.md 15b —
move app/page/WABA to Torpedo, keep Stagename bound until green.

**Prod cleanup:** "Smoke Test Bot" agent + 9 live-verification test rows
deleted via deleteAgentsCascade; loadtest+devin@janis.local throwaway
account removed. 31 decided pending_actions and real thread history
left untouched (records, not residue).

**Meta asset picker UX:** the "still no loader" mystery was CSS — the
skeleton spans used `.nav-skel`, which is scoped `.sidebar .nav-skel`,
so outside the sidebar they had no height/background and rendered as
invisible empty inline elements. Both asset loaders (agent picker +
Chatfuel/ManyChat card) now use `.spin`. Surface labels self-link:
Messenger→m.me/<page>, Instagram→instagram.com/<user>, WhatsApp→
wa.me/<num> (Launch-chat row removed as redundant). Rows top-align
(.asset-row was center-aligned — tall Take-over cells pushed the title
off-axis). Take over AND inert foreign binds both stack
Agent/Workspace/Owner (mailto on the email) — `AssetSurface.owner`
carries same-workspace sibling binds (bound rows already had it from
the API). Bot-ingest card also wrapped MetaAssetList in muted 12px
copy — unwrapped so both call sites render it identically, and
ownLabels use agent_name (was channel name on the bot card).

## Recently shipped (late Oct 2026 session)

Team table unification, notification prefs → modal editors everywhere,
settings reorg (above), invite section separation in the workspace
switcher (light: `ctx-sep` divider + stacked buttons — bordered cards
were rejected as "too much"), self-first roster sorting, bidirectional
name uniqueness. See `git log` ~589f1f2 and the ~15 commits before it.

2026-10-27: approval decisions now reach the customer. `decidePendingAction`
callers (console `/api/actions`, Slack buttons) call
`resumeAfterDecision(db, agent, convId)` instead of a synthetic
`message.user` event — the old resume silently no-op'd because
`newestInboundIsPending` saw the agent's own "sent for approval" reply as
having answered the last inbound. The resume forces one pass (`run.resume`
in `runConversationTurn`), appends a "Resuming after a teammate decision"
prompt section, and adds a trailing user marker so `complete()`'s
trailing-assistant pop doesn't strip the `(teammate approved…)` line.
Human-owned (`state='human'`) threads still stay silent; concierge threads
keep the deterministic "Done — …" line. Also: agent/workspace delete now
cascades every agent-keyed table via `lib/agentCleanup.ts` (`shopify_shops`
was the FK that 500'd deletes).

2026-10-28/29 — undocumented until now (reconciled from git history):

- **Google files connector** — `routes/googleConnect.ts` + four tool
  templates (`google-sheets`/`google-docs`/`google-slides`/`google-drive`
  in toolTemplates.ts). OAuth auth-code flow on the Janis-owned Google
  client; refresh token lands on `agent_connections` (provider 'google'),
  access tokens minted per run. Scopes are deliberately non-restricted:
  spreadsheets + documents + drive.file (drive.readonly dropped 5c1a663 —
  it would trip CASA). Drive picker = Google Picker per card, per-agent
  picked file set, preserves unshare/picks across reconsent; create-file
  adds the new file to the picked set; Office MIMEs convert to Google
  format. Post-consent prompt offers pick OR create. Per-row unshare.
  Sensitive-scope OAuth verification IN FLIGHT (AGENTS.md #15) — until
  it clears, "unverified app" screen + 100-test-user cap.
- **Voice upgrades** — neural TTS + `<Gather bargeIn>` (caller can
  interrupt mid-reply); hosted numbers bill monthly via
  `voice_number_month` usage events (cost+margin, swept by sweeper);
  paid-plan upsell for free workspaces (tappable locked tab, dimmed
  fields — BYO Twilio stays open on free); Voice/SMS channel sections
  live under `TWILIO_CHANNELS_LIVE=1` (A2P cleared 2026-11-03).
- **A2P evidence surface** — static `/sms-optin` page with consent
  disclosures + T&C/privacy links, hosted evidence screenshot,
  `/terms.html` + `/privacy.html` statics for crawlers (Twilio + Google
  verify both need them). Widget 'Text us' footer shows the SMS number
  (`branding.sms_footer` — serializer emits it; opt-in toggle default
  off); help-link/'Text us' toggles hide when they can't render.
- **Hosted chat page for every bubble** — `channelChatUrl` falls back to
  `${apiOrigin}/chat/{id}/page`; branded `*.janis.chat` deferred (see
  AGENTS.md deferred section).
- **Concierge visitor gating** — create_agent is signed-in-only;
  workspace-bound tools (error_reports etc.) hidden from unverified
  visitors; the concierge is told upfront when the visitor isn't
  signed in.
- **Named API keys** — `agent_api_keys` table (migration 0118): multiple
  keys per agent, create/list/revoke/last_used via
  `/api/agents/:id/api-keys`; legacy single key revocable at
  `/api-keys/legacy/revoke`.
- Misc: GA4 event on hosted-chat link click; dictation mic hidden on
  iOS (webkitSpeechRecognition returns nothing); ops alert on first
  external adoption of a non-default LLM vendor; Abilities tab
  per-suggestion dismiss + honest unmet count; console links emit
  www.janis.ai; concierge nav persists on the reply; concierge KB +
  persona refreshed to the live product; Shopify GraphQL
  currentPeriodEnd removal + return line-item quantity fix.

## How Mike likes things (worked examples — honor these)

- **Concise.** Bulleted UI copy over prose paragraphs ("be most concise").
- **Shared components over duplication** — extract common markup rather
  than copy it. He noticed alignment drift and asked why code was
  duplicated. He was right.
- **Modals for editors**, not inline sprawl. Close on Escape/backdrop/X.
- **Tri-state overrides** — Inherit/On/Off, with the inherited value
  visible in the label ("Inherit (shown)").
- **Icons in table headers, pencil for edit buttons**, trash for remove.
- **Hide what a role can't use** — a card a member can't edit shouldn't
  render at all.
- **Self-first ordering** with a muted `(You)` tag everywhere a signed-in
  user appears in a roster.
- Push back where warranted, then implement what he picks — he responds
  well to honest trade-off analysis (e.g. account-level notify baseline).

## Known issues / watch items

- **Devin renderer OOM crashes** — long sessions retain ~64k+ messages /
  2.5–3.5GB against the 4GB V8 heap → exit code 5. Not a Janis bug.
  Keep sessions short; this file exists partly because of it.
- 42–46 in AGENTS.md §Loose ends — prod test residue, untracked images,
  optional zapier-platform-core bump.
- Pre-existing duplicate agent/group names may exist; the uniqueness
  check only blocks new writes. A scan/cleanup script was offered, not
  yet built.

## Open work

AGENTS.md §"Open work — competitive gap tracker" is the canonical list.
External gates (www.janis.ai cutover, Meta/IG app review,
Azure app reg, WorkOS, Stripe yearly prices) are Mike's manual track.
Twilio A2P cleared 2026-11-03 — removed from the gate list.

## Test-replay context hydration (built 2026-10-27)

Scenarios saved from live conversations used to replay bare text turns —
the model saw no session state and behaved worse than live. Now:
- The inspector records each tool call's `key` (name::raw args) + capped
  `result` on the stored reply message — so the console inspector finally
  shows what a call RETURNED, and save time can snapshot real data.
- POST /tests on a conversation snapshots `agent_tests.replay_context`
  (migration 0116): the triggering reply's calls (key → result/outcome),
  verifiedIdentityFor output, userProfile/externalId/agentSummary. Helpers:
  replayContextFor / replayContextFrom in lib/agentTests.ts.
- runAgentTest hydrates: ctx.toolMemo serves stored results for calls the
  live turn made (memo hits now allowed under testRun), ctx.identity from
  the snapshot makes identity-gated tools behave as live, and the conv
  (snapshot, else live row) feeds systemPrompt + knowledgeQueryFor — the
  replay now sees channel/customer context it never had.
- Uncaptured calls still simulate; bare tests (no snapshot) keep the old
  behavior — identity gate + fabricated-id check only apply when a
  snapshot exists. Fetch-capable post-processing (reconcilePagedResult
  fetcher, storefrontTruth, sellableCollectionCounts, page-retry,
  collection-handle resolve) is gated off under testRun — a hydrated
  'ran' result must never fire a real request.
- Results cap at 3000 chars head+tail on the inspector; truncated JSON
  still feeds the model but may not rebuild a cards widget in replay.
- UI: scenario rows with a snapshot show "replays with live session
  context" under the source-conversation link.
- Identity is save-time state: emails verified AFTER the checkpoint save
  are included — no per-turn versioning exists. Acceptable drift.

## Site-crawl knowledge sources (built 2026-10-29)

Whole-site sources are now ONE row, not N flat page rows.
- knowledge_files.parent_id + mime_type 'text/url-site' (migration 0119):
  the site is the parent, discovered pages hang underneath as ordinary
  re-crawled url-source children (sweeper fills stubs, per-page refresh
  unchanged). Row deletes are app-ordered — deleting a site takes its
  children in the same statement; no ON DELETE CASCADE anywhere.
- Recrawl = rediscovery: the site row's refresh cadence calls
  refreshSiteSource → discoverSite (Zendesk API → sitemap → link BFS,
  shared with the import path) then syncSiteChildren diffs: new URLs →
  stubs due now; gone URLs → enabled=false + LEFT_SITE mark (refresh
  nulled so refetches can't clear it), deleted on the next absence;
  returned → re-enabled. Total discovery failure degrades the site row
  and children keep serving last-good — same rot philosophy as pages.
- Re-importing the same root reuses the site row (it's a rediscovery).
  The pasted root URL indexes as a child too — sitemaps don't always
  list it. Children inherit the site's auth headers, cadence, topic.
- UI: paste URL → Add → popup "just this page or crawl the whole site"
  (Modal; the buried '· Crawl a whole website' link is gone). List shows
  "site — N pages · ~X tok", expandable; marked-gone children explain
  their exclusion. Empty-text rows never inject into the prompt.
- Follow-up (same day): stub fills were polite (5/tick ≈ 20min/100pg).
  syncSiteChildren now enqueues one 'knowledge.fill' job whenever it
  creates stubs (import + rediscovery) — runKnowledgeFill drains all
  unfetched children JOB_CONCURRENCY-wide on the next tick. Sweeper's
  per-stub claims remain the fallback if the job never lands.

## 2026-11-05 — Chatfuel relay fixes (Loan Khánh live thread)

Three chatfuel-delivery fixes shipped + deployed (janis-api-01405-jzl+):
- Human sends push on OAuth'd chatfuel channels (HUMAN_AGENT tag); agent
  replies stay ingest-response-only — Chatfuel owns delivery. This is what
  let Loan take over her own bot thread live (verified on Messenger).
- `delivered` now stamps only when a reply actually leaves (card response
  or real push) — pull-only rows no longer fake Delivered.
- Internal/system markers (handoff, sentiment, status) filtered from
  `waitForOutbound` — they were leaking into Messenger via the card.
- Pair-count dedup (v=card-stamped vs m=mid-stamped halves in 90s window)
  replaces the raced one-sided text dedup — webhook+card double-feed now
  collapses whichever copy lands second; genuine repeats still ingest.
- Handoff line is localized: the model is told its pre-tag text is the
  customer-facing line (acknowledge in the customer's language), and
  bare-tag fallbacks compose a one-shot localized line via complete()
  with canned English as the failure fallback. Escalation tests stub the
  extra compose call.
