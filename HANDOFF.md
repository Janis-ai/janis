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
confirmed working via the voice channel's subaccount (same number);
the real SMS blocker is A2P 10DLC registration (external, awaiting
Twilio review), not code.

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
  gated behind `TWILIO_CHANNELS_LIVE` until A2P clears.
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
External gates (www.janis.ai cutover, Meta/IG app review, Twilio A2P,
Azure app reg, WorkOS, Stripe yearly prices) are Mike's manual track.

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
