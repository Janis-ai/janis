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

## Recently shipped (late Oct 2026 session)

Team table unification, notification prefs → modal editors everywhere,
settings reorg (above), invite section separation in the workspace
switcher (light: `ctx-sep` divider + stacked buttons — bordered cards
were rejected as "too much"), self-first roster sorting, bidirectional
name uniqueness. See `git log` ~589f1f2 and the ~15 commits before it.

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

## Test-replay context hydration (planned, not built)

Scenarios saved from live conversations replay text-only turns — the model
behaves worse than live because session state is missing. Findings:
- ctx.convId = sourceConversationId already loads the real userProfile
  (form-collected metadata) — done, free.
- testRun already stubs EVERY tool call (simulated/proposed) — replays
  are side-effect safe by design; hydration must stay in-memory, never
  write to the real conversation.
- GAP: tool RESULTS are not persisted (inspector keeps args/outcome/error
  only), so replay can't recover "order #1005 = these items/this state".
  Build: at test save time (agents.ts POST /tests), snapshot the source
  conv's triggering-turn tool results + verified emails + profile into a
  new agentTests.replay_context jsonb column; at run time (agentTests.ts),
  seed ctx.toolMemo (callKey → stored result) so identical calls replay
  real data, and pass verified emails so identity-gated tools behave as
  live. Migration needed for the column.
