# @janis/shared

Shared contracts for the [Janis](https://app.janis.ai) agent-oversight
platform — zod schemas and types for the ingest API, outbound webhooks, and
agent configuration. You usually want [`@janis/sdk`](https://www.npmjs.com/package/@janis/sdk)
instead; this package exists so agents and tooling can validate Janis
payloads directly.

```ts
import { IngestEvent, OutboundWebhook, AgentConfig } from '@janis/shared';
```

Docs: https://app.janis.ai/docs
