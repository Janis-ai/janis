import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMe } from '../api/hooks';
import { api } from '../api/client';
import { BrandImg, SiteFooter } from '../components/bits';
import OperatorDocs from './OperatorDocs';

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
  ['handoff_offer', 'Agent offered a human — alerts operators without escalating', 'conversation_id, reason?'],
  ['handoff_cancelled', 'Customer declined a human — drops needs_human back to the agent and resolves open alerts', 'conversation_id, reason?'],
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

const AUTOMATION = [
  ['GET /v1/me', 'Agent identity — { id, name }. Zapier uses this to label the connection.'],
  ['GET /v1/conversations', 'Newest-first list. ?state=needs_human|archived|active|human|snoozed filters.'],
  ['POST /v1/conversations/:external_id/reply', '{ text } — send a reply as the agent.'],
  ['PATCH /v1/conversations/:external_id/user', '{ name?, email?, external_id?, traits? } — push what your backend knows about the end user. Server-to-server, so external_id lands verified and traits merge into the profile the agent sees.'],
  ['POST /v1/conversations/:external_id/escalate', '{ reason? } — flag needs_human, alerts operators.'],
  ['POST /v1/conversations/:external_id/resume', 'Hand a needs_human conversation back to the AI.'],
  ['POST /v1/conversations/:external_id/resolve', 'Archive + send the CSAT survey. Idempotent.'],
  ['POST /v1/send', '{ to, text, subject?, channel_id?, whatsapp_template? } — open or continue an outbound thread. Returns conversation_id and external_id.'],
  ['GET /v1/channels', 'The agent\'s channels — { id, kind, name, outbound }. Feed channel_id into /v1/send.'],
  ['GET /v1/hooks', 'List REST-hook subscriptions.'],
  ['POST /v1/hooks', '{ target_url, event } — subscribe to instant pushes. Events: new_conversation, conversation_escalated, conversation_resolved.'],
  ['DELETE /v1/hooks/:id', 'Unsubscribe. Zapier calls this when a Zap turns off.'],
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
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
    } catch {
      // clipboard API needs a secure context — fall back for older setups
      const ta = document.createElement('textarea');
      ta.value = children;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="docs-code-wrap">
      <button className="docs-copy" onClick={copy} title="Copy to clipboard" aria-label="Copy code">
        {copied ? '✓' : '⧉'}
      </button>
      <pre className="docs-code">{children}</pre>
    </div>
  );
}

export default function Docs() {
  const { data } = useMe();
  const [params, setParams] = useSearchParams();
  const guide = params.get('guide');
  const tab = guide === 'operator' ? 'operator' : guide === 'automation' ? 'automation' : 'api';
  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' });
    window.location.href = '/';
  };
  return (
    <div className="landing" style={{ maxWidth: 760 }}>
      <nav className="landing-nav">
        <Link to="/"><BrandImg className="landing-logo" alt="Janis" /></Link>
        {data ? (
          <span className="row" style={{ gap: 8 }}>
            <Link to="/conversations" className="btn primary">Open console</Link>
            <a
              className="btn"
              href="/login"
              onClick={(e) => {
                e.preventDefault();
                void signOut();
              }}
            >
              Sign out
            </a>
          </span>
        ) : (
          <Link to="/login" className="btn">Sign in</Link>
        )}
      </nav>

      <div className="row" style={{ gap: 8, margin: '16px 0 4px' }}>
        <button
          className={`btn ${tab === 'api' ? 'primary' : ''}`}
          onClick={() => setParams({})}
        >
          Agent API &amp; BYOK
        </button>
        <button
          className={`btn ${tab === 'automation' ? 'primary' : ''}`}
          onClick={() => setParams({ guide: 'automation' })}
        >
          Automation API
        </button>
        <button
          className={`btn ${tab === 'operator' ? 'primary' : ''}`}
          onClick={() => setParams({ guide: 'operator' })}
        >
          Operator guide
        </button>
      </div>

      {tab === 'operator' ? (
        <OperatorDocs />
      ) : tab === 'automation' ? (
        <>
      <h1>Automation API</h1>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Drive Janis from Zapier, Make, n8n, or plain HTTP — read conversations,
        reply, escalate, resolve, and subscribe to instant pushes. Works for
        hosted and BYOK agents alike.
      </p>

      <h2>Authentication</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Every request carries the agent's API key — generate one in the console:
        agent → <strong>Connection</strong> tab → Credentials → Generate API key.
        Send it as <span className="mono">X-API-KEY: &lt;key&gt;</span> (what
        Zapier's API-key auth sends natively) or{' '}
        <span className="mono">Authorization: Bearer &lt;key&gt;</span>. Keys start
        with <span className="mono">jk_live_</span>.
      </p>
      <Code>{`curl https://app.janis.ai/v1/me \\
  -H "X-API-KEY: jk_live_..."`}</Code>

      <h2>Endpoints</h2>
      <Table head={['Endpoint', 'Purpose']} rows={AUTOMATION} />
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Two IDs exist per conversation: <span className="mono">id</span> is the
        internal UUID; <span className="mono">external_id</span> is the stable key
        every action route takes (<span className="mono">email:jane@…</span>,
        <span className="mono">webchat:test:…</span>). Trigger payloads return
        both — always map <span className="mono">external_id</span> into action
        URLs.
      </p>

      <h2>Instant triggers — REST hooks</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        <span className="mono">POST /v1/hooks</span> registers a target URL for an
        event; Janis POSTs the serialized conversation (the same shape{' '}
        <span className="mono">GET /v1/conversations</span> returns) the moment
        the event happens — no polling. This is exactly what Zapier REST-hook
        triggers subscribe to; Make and n8n webhook nodes work the same way.
      </p>
      <Code>{`curl -X POST https://app.janis.ai/v1/hooks \\
  -H "X-API-KEY: jk_live_..." -H "content-type: application/json" \\
  -d '{"target_url":"https://hooks.example.com/catch/abc",
       "event":"conversation_escalated"}'
# → {"id":"…","event":"conversation_escalated","target_url":"…"}

curl -X DELETE https://app.janis.ai/v1/hooks/<id> \\
  -H "X-API-KEY: jk_live_..."`}</Code>

      <h2>Zapier</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Search <strong>Janis</strong> in the Zapier editor — triggers fire on new,
        escalated, and resolved conversations; actions reply, escalate, resume,
        resolve, and send outbound. Connect with the agent API key above.
      </p>

      <h2>Recipes — ManyChat &amp; GoHighLevel</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Any tool that can fire an HTTP request can hand a conversation to Janis.
        POST one batch to <span className="mono">/v1/events</span>: a{' '}
        <span className="mono">message_in</span> records what the customer said
        (creating the conversation on first use), and a{' '}
        <span className="mono">handoff_request</span> pages your operators.
        Prefix <span className="mono">conversation_id</span> with the source so
        ids never collide — <span className="mono">manychat:{'{'}user_id{'}'}</span>.
      </p>
      <Code>{`# ManyChat: External Request action (or a GHL workflow webhook)
POST https://app.janis.ai/v1/events
Authorization: Bearer jk_live_...
Content-Type: application/json

{
  "events": [
    {
      "type": "message_in",
      "conversation_id": "manychat:{{user_id}}",
      "text": "{{last_text_input}}",
      "user": { "name": "{{first_name}} {{last_name}}" }
    },
    {
      "type": "handoff_request",
      "conversation_id": "manychat:{{user_id}}",
      "reason": "customer asked for a human in ManyChat"
    }
  ]
}`}</Code>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        In ManyChat: add an <strong>External Request</strong> action to the flow,
        method POST, the URL above, and map the user's id/name/last input into
        the body. In GoHighLevel: use a workflow <strong>Webhook</strong> action
        (or a custom webhook step) with the same payload — GHL merge fields
        stand in for the {'{{…}}'} placeholders. Omit the{' '}
        <span className="mono">handoff_request</span> event to route the message
        to the agent instead of straight to a human.
      </p>
        </>
      ) : (
        <>
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
      <Code>{`JANIS_API_KEY=jk_live_... LLM_API_KEY=sk-... npx janis-agent
# or with Docker:
docker run -e JANIS_API_KEY=jk_live_... -e LLM_API_KEY=sk-... \\
  -p 9798:9798 ghcr.io/janis-ai/janis-agent`}</Code>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Get the key from the agent's Engine tab → Generate API key (shown once).
        Then set your agent's webhook URL (console → Agents → your agent →
        Engine) to <span className="mono">https://your-host:9798/webhook</span>.
        Without <span className="mono">LLM_API_KEY</span> every message hands off to a
        human — a safe way to test the plumbing.
      </p>

      <h2>Reporting to Janis</h2>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        Authenticate every call with <span className="mono">Authorization: Bearer
        &lt;agent api key&gt;</span>. Plain HTTPS works everywhere; for Node agents the
        SDK wraps all of it — <span className="mono">npm install janis</span>:
      </p>
      <Code>{`import { Janis } from 'janis';
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
      <Code>{`import { verifySignature } from 'janis/webhook';
import type { OutboundWebhook } from 'janis/webhook';

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
        </>
      )}

      <SiteFooter style={{ marginTop: 48 }} />
    </div>
  );
}
