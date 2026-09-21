# @janis/agent-template

A runnable, config-driven support agent for [Janis](https://app.janis.ai). Use it
as-is for a working LLM bot, or fork it as the starting point for your own
BYOK (bring-your-own-key) agent.

It polls `GET /v1/config` for its system prompt / knowledge / tone (edit them
in the Janis console — no redeploy), answers `message.user` webhooks, drafts
operator suggestions, and honors the takeover contract: when a human takes
over, it goes quiet.

## Run it

```bash
docker run -e JANIS_API_KEY=jk_live_... -e LLM_API_KEY=sk-... \
  -p 9798:9798 ghcr.io/janis-ai/janis-agent
```

Then set your agent's **webhook_url** (Agents → your agent → Connection) to
`https://<your-host>:9798/webhook`.

| Env | Default | Purpose |
| --- | --- | --- |
| `JANIS_API_KEY` | — | **required** — agent API key from the console |
| `JANIS_BASE_URL` | `https://app.janis.ai` | Janis API origin |
| `JANIS_WEBHOOK_SECRET` | — | verify `x-janis-signature` (recommended) |
| `LLM_API_KEY` | — | OpenAI-compatible key; without it every message hands off to a human |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | any OpenAI-compatible endpoint |
| `LLM_MODEL` | `gpt-4o-mini` | model name |
| `PORT` | `9798` | webhook receiver port |

## Endpoints

- `POST /webhook` — Janis outbound events (`message.user`, `human.takeover`, …)
- `POST /chat` — `{conversation_id, text, name?}` — local testing without a channel
- `GET /health`

## Handoff behavior

Reply with the token `[HANDOFF]` (the built-in system prompt instructs the
model to do this when it can't help) and the template calls
`requestHuman` — the conversation lands in the operator inbox with an alert.

Docs: https://app.janis.ai/docs
