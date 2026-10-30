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

- Each platform user gets a conversation in your shared inbox — the whole
  thread is visible, searchable, and evaluable like any channel.
- Meta-family surfaces share the thread: if the Page is also subscribed to
  Janis's Meta webhook, a message seen on both paths lands **once** in the
  same conversation (messenger/instagram/chatfuel/manychat key on the same
  PSID).
- A teammate can take over from the inbox, or directly in Facebook Page
  Inbox: while a human owns the conversation the endpoint replies
  **empty** — the bot goes silent. Hand it back in the console (or wait
  out the auto-resume window) and the agent answers again.
- The ingest waits ~15s for the agent's answer; slower turns reply empty
  and the conversation still captures the inbound.

## Optional: see every message (secondary receiver)

The bot forwards only what its flow reaches. To capture *all* inbound Page
messages — including ones the bot never forwards — subscribe the Page to
Janis's Meta webhook as a **secondary receiver** (the bot stays primary):

1. On the channel's page in the console, open **See every message**.
2. Paste your Facebook Page ID and save.
3. In your Meta app (developers.facebook.com → Messenger → Webhooks),
   subscribe the Page with the webhook URL + verify token shown there.

Inbound messages then join the same shared conversation — no duplicates —
and a human replying in Page Inbox pauses the agent here too.

## Migrating from old Janis

If your bot already points at `…/messenger/client/<client_key>/chatfuel/fallback`,
the same `client_key` works on the new URL — repointing the card at
`/bot/<client_key>/chatfuel` moves that bot onto the new pipeline (knowledge,
tools, evals, shared inbox). The legacy URL keeps running Dialogflow for
migrated bots until you switch it.
