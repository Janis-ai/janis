import { Link } from 'react-router-dom';

const INBOUND = [
  ['POST /v1/events', 'Batch-ingest events (below). The SDK wraps this — every call returns per-event results including paused.'],
  ['GET /v1/conversations/:externalId/state', 'Polling fallback → { state, paused }. For agents that cannot receive webhooks.'],
  ['POST /v1/suggestions', '{ conversation_id, text } — answer a suggestion.request webhook with a drafted reply.'],
  ['GET /v1/config', "Your agent's console-managed config: system_prompt, knowledge, tone, greeting, quick_replies, tools, llm."],
  ['POST /v1/agents/me/webhook-test', 'Fire a test message.human webhook at your webhook_url.'],
];

const EVENTS = [
  ['message_in', 'An end-user message your agent received', 'conversation_id, text, user?'],
  ['message_out', 'A reply your agent sent', 'conversation_id, text, payload?'],
  ['failure', 'Your agent failed to handle something — fires an alert', 'conversation_id, reason?, payload?'],
  ['handoff_request', 'Explicitly ask a human to take over', 'conversation_id, reason?'],
  ['custom_alert', 'Fire a custom alert (e.g. refund_requested)', 'conversation_id, alert_type, text?'],
];

const WEBHOOKS = [
  ['message.user', 'End user messaged on a hosted channel — reply via /v1/events'],
  ['human.takeover', 'A human took over — go quiet for this conversation'],
  ['message.human', 'The operator sent a message to the end user'],
  ['human.resume', 'The human released the conversation — you may resume'],
  ['agent.send', 'Operator asked you to deliver text to the end user verbatim'],
  ['suggestion.request', 'Operator asked for a suggested reply — POST it to /v1/suggestions'],
];

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <table className="docs-table">
      <thead>
        <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r[0]}>
            {r.map((c, i) => (
              <td key={i} className={i === 0 ? 'mono' : 'muted'}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="docs-code">{children}</pre>;
}

export default function Docs() {
  return (
    <div className="landing" style={{ maxWidth: 760 }}>
      <nav className="landing-nav">
        <Link to="/"><img className="landing-logo" src="/img/janis-top.png" alt="Janis" /></Link>
        <Link to="/login" className="btn">Sign in</Link>
      </nav>

      <h1>Agent API &amp; BYOK</h1>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Janis can run your agent for you (hosted), or sit in front of an agent you run
        yourself — "bring your own key". A BYOK agent receives signed webhooks when
        customers and operators interact, and reports its traffic back through a small
        REST API. Your agent keeps its own model, code, and infra; Janis supplies the
        inbox, takeover, alerts, and channels.
      </p>

      <h2>Quickstart — the agent template</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <span className="mono">janis-agent</span> is a runnable reference
        agent in a single Docker image: it polls its console-managed config,
        answers user messages with any OpenAI-compatible LLM, and honors
        takeover. Run it as-is or fork the source as your starting point.
      </p>
      <Code>{`docker run -e JANIS_API_KEY=jk_live_... -e LLM_API_KEY=sk-... \\
  -p 9798:9798 ghcr.io/janis-ai/janis-agent`}</Code>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Get the key from the agent's Connection tab → Generate API key (shown once).
        Then set your agent's webhook URL (console → Agents → your agent →
        Connection) to <span className="mono">https://your-host:9798/webhook</span>.
        Without <span className="mono">LLM_API_KEY</span> every message hands off to a
        human — a safe way to test the plumbing.
      </p>

      <h2>Reporting to Janis</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Authenticate every call with <span className="mono">Authorization: Bearer
        &lt;agent api key&gt;</span>. Plain HTTPS works everywhere; for Node agents the
        SDK (<span className="mono">@janis/sdk</span> — coming to npm) wraps all of it:
      </p>
      <Code>{`import { Janis } from '@janis/sdk';
const janis = new Janis({ apiKey: process.env.JANIS_API_KEY });

const res = await janis.userMessage('conv-42', 'where is my order?', { name: 'Jane' });
await janis.agentMessage('conv-42', 'Let me look that up.');

// when paused is true a human owns the conversation — stay quiet
if (res.results[0]?.paused) { /* stop replying */ }

await janis.requestHuman('conv-42', 'customer asked for a refund');`}</Code>
      <Table head={['Endpoint', 'Purpose']} rows={INBOUND} />
      <Table head={['Event type', 'Meaning', 'Key fields']} rows={EVENTS} />
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Up to 500 events per <span className="mono">POST /v1/events</span> call.
      </p>

      <h2>Webhooks — Janis → your agent</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Janis POSTs JSON to your agent's webhook URL. Non-2xx responses retry at
        0s / 1s / 5s / 15s, then the delivery is marked failed — every attempt is
        visible under Connection → Deliveries in the console.
      </p>
      <Code>{`{
  "type": "message.user",
  "conversation_id": "conv-42",          // your external id
  "janis_conversation_id": "8f14…",
  "text": "where is my order?",
  "user":  { "name": "Jane", "channel": "messenger" },
  "channel": { "kind": "messenger", "name": "Storefront page" },
  "timestamp": "2026-09-19T16:00:00.000Z"
}`}</Code>
      <Table head={['Type', 'Meaning']} rows={WEBHOOKS} />

      <h3>Verifying signatures</h3>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        When a webhook secret is set (console → Agents → your agent → Connection →
        Show webhook secret), every delivery carries{' '}
        <span className="mono">x-janis-signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</span>{' '}
        where <span className="mono">v1 = HMAC-SHA256(secret, "t.body")</span> over the
        exact raw request body. Verify before parsing:
      </p>
      <Code>{`import { verifySignature } from '@janis/sdk/webhook';
import type { OutboundWebhook } from '@janis/shared';

app.post('/janis/webhook', (req, res) => {
  if (!verifySignature(secret, req.headers['x-janis-signature'], req.rawBody)) {
    return res.sendStatus(401);
  }
  const event = JSON.parse(req.rawBody) as OutboundWebhook;
  // …handle by event.type…
  res.sendStatus(200);
});`}</Code>

      <h2>The takeover contract</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        One rule makes the whole thing safe: <strong>when a human owns a
        conversation, your agent stays quiet.</strong> Learn it three ways —
        <span className="mono"> paused: true</span> in every ingest response, the{' '}
        <span className="mono">human.takeover</span> webhook, or the state polling
        endpoint. <span className="mono">human.resume</span> releases it back.
        While paused, Janis still transcribes what the human says — your agent just
        shouldn't answer.
      </p>

      <footer className="landing-footer muted" style={{ marginTop: 48 }}>
        <span>© {new Date().getFullYear()} Janis</span>
        <Link to="/">Home</Link>
        <Link to="/privacy">Privacy Policy</Link>
        <Link to="/terms">Terms of Service</Link>
      </footer>
    </div>
  );
}
