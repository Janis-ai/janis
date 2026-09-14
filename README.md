# Janis — human oversight for AI agents

Janis watches your AI agents so you don't have to. Agents report conversations
over a tiny API; when something fails or a user asks for a human, Janis alerts
your team (web app, push, Slack optional) and lets an operator take over live —
the agent is told to pause, human replies are relayed to the agent's webhook,
and the conversation can be handed back.

## Layout

```
apps/api        Hono + Postgres (Drizzle). Dev uses embedded PGlite — zero install.
apps/web        Vite + React PWA console: live inbox, takeover, agent/channel/alert management.
packages/shared zod schemas + types shared by api, web, sdk.
packages/sdk    @janis/sdk — thin client agents use to report + receive takeover.
```

## Quickstart

```bash
npm install
npm run dev          # api on :8787, web on :5173
```

First boot seeds a workspace and prints an admin login and a demo agent API key.
Data lives in `apps/api/.pglite` (delete to reset). To use real Postgres:
`docker compose up -d` and set `DATABASE_URL` in `apps/api/.env`.

## Try the takeover loop

```bash
# terminal 3 — fake agent that reports to Janis and receives human messages
JANIS_API_KEY=jk_live_... npm run demo-agent
```

Then open http://localhost:5173, sign in, watch the conversation appear in the
Inbox, click **Take over**, and reply — the demo agent prints your message.

## Agent integration

```ts
import { Janis } from '@janis/sdk';
const janis = new Janis({ apiKey: 'jk_live_...', baseUrl: 'https://api.janis.ai' });

// around your agent loop:
const r = await janis.userMessage(convId, userText);
if (r.results[0].paused) return; // a human owns this conversation — stay quiet
const reply = await myAgent(userText);
await janis.agentMessage(convId, reply);

// when your agent is stuck:
await janis.requestHuman(convId, 'billing dispute');
```

Human messages arrive at your agent's `webhook_url` as signed POSTs
(`human.takeover`, `message.human`, `human.resume`). Verify with
`verifySignature` from `@janis/sdk/webhook`. Agents that can't receive webhooks
can poll `janis.isPaused(convId)` — every `send()` response also carries `paused`.

## API surfaces

- `POST /v1/events` — batch ingest (Bearer agent key). Events: `message_in`,
  `message_out`, `failure`, `handoff_request`, `custom_alert`.
- `GET /v1/conversations/:externalId/state` — `{state, paused}` polling fallback.
- `/api/*` — console API (session cookie): agents, conversations, alerts, rules,
  stream (SSE), push subscriptions, users.
- `/auth/*` — login/logout/me.

## Alert rules

Per-agent rules: `keyword` (matched against inbound text), `failure`,
`handoff_request`, `custom_alert`, `inactivity` (minutes with user waiting).
With no rules configured, failure/handoff/custom always fire.

## Slack integration

Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` on the API,
then connect from **Settings → Slack** (OAuth install). Slack app config:

- Redirect URL: `{API_ORIGIN}/slack/oauth/callback`
- Event subscriptions: `{API_ORIGIN}/slack/events` — subscribe to `message.channels`, `message.groups`
- Interactivity URL: `{API_ORIGIN}/slack/interactions`
- Scopes: `chat:write`, `chat:write.public`, `channels:read`, `groups:read`,
  `users:read`, `users:read.email`

Alerts post to the chosen channel with **Take over / Resume** buttons; each
conversation gets a Slack thread, and replying in the thread takes over and
relays to the end user.

## Agent template + hosted channels

`@janis/agent-template` is a runnable, config-driven support agent: it polls
`GET /v1/config` for its system prompt/knowledge/tone (edited per-agent in the
console), answers `message.user` webhooks, drafts suggestions, and honors
takeover.

    JANIS_API_KEY=jk_live_... LLM_API_KEY=sk-... npm run start -w packages/agent-template

Set the agent's `webhook_url` to the template's `/webhook`. It also serves
`POST /chat` for local testing without a channel.

**Hosted channels** (Integrations page): Messenger, Instagram DMs, and WhatsApp
Business via one Meta webhook — `{API}/channels/meta/webhook`. Janis owns the
pipe: inbound messages reach the agent only while it owns the conversation, so
human takeover is *enforced*, not cooperative. Human/agent replies deliver back
through the channel automatically. Set `META_APP_SECRET` for signature checks.

## Deploy

API: `Dockerfile.api` builds a Node image; needs `DATABASE_URL` (Postgres) and
`SESSION_SECRET`. Web: `npm run build -w apps/web` → static `dist/` on any host;
set the API origin via the Vite proxy or serve API + web behind one domain.
