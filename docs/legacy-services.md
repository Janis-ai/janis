# Legacy Janis/Wordhop service inventory

Everything in `current/` — the old distributed system the reboot replaces.

## Janis/Wordhop production services (the old system)

| Folder | Package | Role |
|---|---|---|
| `wordhopapi` | janis-www | Web app + API aggregator (Express/Mongo + React dashboard). The repo we analyzed. `api/v1/app.js` requires `common`/`hop` which live in janis-webhook — it proxies, doesn't contain the core logic. |
| `wordhopapi-good` | janis-www | Newer snapshot/backup of the same app (Nov 2025). |
| `wordhopapi-old` | janis-www | Older copy (Oct 2025). |
| `janis-api` | janis-api | REST API service (Heroku Procfile). Vendored `multilang-sentiment` for alerting on upset users. |
| `janis-broadcast-api` | janis-api | Variant of janis-api for broadcast messaging. |
| `janis-webhook` | janis-webhook | **Webhook ingestion service — contains `api/v1/common.js`**, the normalize/findBot/findChannel middleware missing from janis-www. This is where bot traffic entered the system. |
| `janis-web` | janis-web | Embeddable web-chat widget + sample bot (Botkit 4 + botbuilder-adapter-web + botkit-plugin-cms). |
| `wordhop-slack` | wordhop-slack | The Slack app (Botkit bot + follow-up dialogs in `src/followups/`). Human takeover UX lived here. |
| `wordhop-socket-server` | socket-chat-example | socket.io relay — bots held a socket connection (`bot.socket_id` in the Bot model) and the API pushed human replies down it. Superseded by signed webhooks in the reboot. |
| `aws` | janis-api | AWS SAM/Lambda port of janis-api (`src/api`, `src/handlers` = email lambdas: welcome/invite/emailer). |
| `janis-api-aws` | — | Empty directory. |
| `botcopy` | — | Empty directory (Botcopy web-chat integration, abandoned). |
| `email` | — | Loose JSON templates (`myemail.json`, `mytemplate.json`). |

## Unrelated projects

- `robinbot` — Robinhood trading bot (JS)
- `Momentum-Trading-Example` — Python momentum trader
- `janis` — **the reboot** (this monorepo)

## Lessons baked into the reboot

- The old system needed **six services** (web app, REST API, webhook ingress, socket relay, Slack bot, broadcast API) to do what the new `apps/api` does in one process. Consolidation is intentional.
- Old takeover transport was socket.io to the bot + Slack interactivity to the human. New transport is signed outbound webhooks to the agent + SSE/push to operators — stateless and horizontally scalable if ever needed.
- The old multi-platform normalize middleware (`common.js`: Messenger/Microsoft/Slack payload detection) is replaced by a single agent-owned event schema — agents send canonical events instead of Janis parsing every platform's wire format.
- `hop.js` (the routing engine) was never in any of these folders — it lived only in deployed builds. Nothing in the reboot depends on it.
