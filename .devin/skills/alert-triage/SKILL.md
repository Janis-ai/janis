---
name: alert-triage
description: Triage a Janis concierge/run-issue alert — reconstruct what the agent did from prod Postgres, decide whether the guard worked or the product has a gap, and fix it
argument-hint: "<pasted alert or conversation URL>"
allowed-tools:
  - read
  - grep
  - glob
  - exec
---

# Alert triage

Mike pastes concierge alerts that look like:

```
<customer> on <channel>: <run issue, e.g. "stripped an unbacked action claim">
agent: Janis · channel: … · customer: … · last: "<truncated inbound text>"
https://www.janis.ai/conversations/<uuid>
```

Treat these as bug reports against the hosted-agent pipeline, not noise.
The goal: reconstruct exactly what the model did, decide whether the
guardrail worked as designed or the product has a gap, and ship a fix
when it's the latter.

## 1. Find the mechanism in code

The run-issue strings come from `runIssues` at the end of the hosted
reply pipeline — grep `apps/api/src/lib/hostedAgent.ts` for the phrase
("stripped an unbacked action claim", "unverified card item(s)", etc.).
Read the guard that produced it: what it matches, when it regenerates
vs. strips, and what inspector flag it stamps (`payload.inspector` on
the stored reply, e.g. `claim_guard: 'stripped'`).

## 2. Pull the conversation from prod Postgres

Prod DB is Neon. Never print the URL — pipe it:

```bash
cd apps/api
psql "$(grep '^DATABASE_URL=' .env.production | cut -d= -f2-)" -x -c "
SELECT created_at, direction, left(text, 1200) AS text, payload->'inspector' AS inspector
FROM messages WHERE conversation_id = '<uuid>' ORDER BY created_at;"
```

Read the WHOLE thread, oldest first — the trigger is almost always
earlier context (a parked approval card, an attachment batch, a prior
tool call), not the last message. Useful columns:

- `direction`: `in` customer, `out` agent, `human` operator/internal.
  `payload.internal = true` rows are rail notes (action proposed /
  approved), never shown to the visitor.
- `payload->'inspector'`: model, kb docs loaded, tool calls with args +
  results (`inspector.tools`), guard flags (`claim_guard`,
  `widget_guard`, `lookup_guard`), `esc_claim_stripped`.
- `payload->'attachments'`: uploads — blobs live in the `uploads` table
  (`convert_from(data,'UTF8')` for text files). Filenames in message
  text are just `📎 name`; file contents reach the model via
  `fileAnalysis`/`attachmentContent` only when `fileAnalysisAllowed`.

Follow-up state: check `pending_actions`, `agents`, `channels`, and
`conversations` for the workspace/agent to see what actually landed
(did the agent get created? channels bound? did the visitor come back?).

## 3. Judge: guard working, or product gap

The alert firing usually means the guard DID its job — the question is
what forced the model into the guard's arms. Reconstruct the turn:
what did the model have in context (attachments loaded? tools
offered?), what did it claim/promise, and was there an honest action
it could have taken instead? If the model had no truthful path (a tool
it can't call, a state it can't revise), that's the bug — fix the
capability, not the symptom. If it had the tool and didn't use it,
consider whether the tool description or prompt steers wrong.

## 4. Ship

- Fix in the tool/executor/prompt layer with a regression test —
  `builtinTools.test.ts` / `hostedAgent.test.ts` conventions
  (PGlite + drizzle migrate in beforeAll).
- `npm run typecheck` then `npm test -w apps/api`.
- Commit by name (never `git add -A` — parallel sessions share the
  tree; check `git status`/`git diff --stat` first and leave other
  sessions' WIP files alone even if they break preflight — fix the
  blocker minimally in the working tree without staging it).
- Push (preflight gate runs the suite) and deploy via
  `./scripts/deploy-gcp.sh` in the background; verify `Deployed:` in
  the log before reporting done.
- Log it under "Recently shipped" in HANDOFF.md.

## 5. Report back

Tell Mike: the timeline (who did what, timestamps), whether the guard
was right, what shipped (commit), and any residual gap that needs a
human decision — e.g. a visitor promised something that didn't land,
or a customer's prod data that needs patching. Patching a customer's
agent/workspace in prod is a real-world mutation — do it only when
Mike asks; when he does, use the real code path (e.g.
`extractKnowledgeText` + `knowledge_files` insert via a throwaway tsx
script against prod DATABASE_URL), not hand-rolled SQL.
