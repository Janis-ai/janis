# @janis/sdk

Client for the [Janis](https://app.janis.ai) agent-oversight platform. Report
conversation traffic, flag failures, request human takeover — and receive
signed webhooks when operators step in.

```bash
npm install @janis/sdk
```

## Usage

```ts
import { Janis } from '@janis/sdk';

const janis = new Janis({
  apiKey: process.env.JANIS_API_KEY!,        // jk_live_… from the agent's page
  baseUrl: 'https://app.janis.ai',           // default
});

// report what your agent saw and said
const res = await janis.userMessage('conv-42', 'where is my order?', {
  name: 'Jane', channel: 'webchat',
});
await janis.agentMessage('conv-42', 'Let me look that up for you.');

// every call returns per-event results — when `paused` is true a human owns
// the conversation and your agent must stay quiet
if (res.results[0]?.paused) { /* stop replying */ }

// escalate when you can't help
await janis.requestHuman('conv-42', 'customer asked for a refund');
await janis.failure('conv-42', 'LLM timeout');
await janis.customAlert('conv-42', 'angry_user', 'customer is upset');

// polling fallback if you can't receive webhooks
await janis.isPaused('conv-42');
```

## Receiving webhooks

Janis POSTs signed events to your agent's `webhook_url`. Verify with the
agent's webhook secret:

```ts
import { verifySignature } from '@janis/sdk/webhook';
import type { OutboundWebhook } from '@janis/shared';

app.post('/janis/webhook', (req, res) => {
  if (!verifySignature(secret, req.headers['x-janis-signature'], req.rawBody)) {
    return res.sendStatus(401);
  }
  const event = JSON.parse(req.rawBody) as OutboundWebhook;
  // event.type: message.user | human.takeover | message.human |
  //             human.resume | agent.send | suggestion.request
  res.sendStatus(200);
});
```

Signature format: `x-janis-signature: t=<unix seconds>,v1=<hex>` where `v1`
is `HMAC-SHA256(secret, "${t}.${rawBody}")`.

Full contract + quickstart: https://app.janis.ai/docs
