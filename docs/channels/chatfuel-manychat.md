# Connect a Chatfuel or ManyChat bot

Your existing bot stays the front door — Janis becomes its brain. The
platform's HTTP step posts each user message to Janis and the agent's reply
goes back in the response.

## Get your ingest URL

1. Console → your agent → **Channels** → **Chatfuel / ManyChat** → Connect.
2. The new channel's page shows the ingest URL:
   `https://app.janis.ai/bot/<key>/chatfuel` or `…/manychat`.
   The key is per-agent — minted once, shared by both platforms.

## Chatfuel

In the flow where you want Janis to answer, add a **JSON API** card:

- Type: `POST`
- URL: your ingest URL (`…/chatfuel`)
- Attributes to send: `messenger user id` = `{{messenger user id}}`,
  `user input` = `{{last user freeform input}}`

The card's response `messages[*].text` is the agent's reply — display it as
the bot's message.

## ManyChat

Add an **External Request** action:

- Method: `POST`
- URL: your ingest URL (`…/manychat`)
- Body: `{ "id": {{subscriber_id}}, "custom_fields": { "user input": "{{last_input_text}}" } }`

The response `content.messages[*].text` is the agent's reply.

## Behavior

- Each platform user gets a conversation in your shared inbox
  (`chatfuel:<psid>` / `manychat:<subscriber_id>`) — the whole thread is
  visible, searchable, and evaluable like any channel.
- A teammate can take over from the inbox: while a human owns the
  conversation the endpoint replies **empty** — the bot goes silent until
  it's handed back.
- The ingest waits ~15s for the agent's answer; slower turns reply empty
  and the conversation still captures the inbound.

## Migrating from old Janis

If your bot already points at `…/messenger/client/<client_key>/chatfuel/fallback`,
the same `client_key` works on the new URL — repointing the card at
`/bot/<client_key>/chatfuel` moves that bot onto the new pipeline (knowledge,
tools, evals, shared inbox). The legacy URL keeps running Dialogflow for
migrated bots until you switch it.
