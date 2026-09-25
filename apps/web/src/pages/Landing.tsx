import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMe } from '../api/hooks';
import { api } from '../api/client';
import { SiteFooter } from '../components/bits';

const FEATURES = [
  {
    icon: '/img/value-delight.png',
    title: 'AI proposes, you approve',
    body: 'Refunds, order changes, subscription edits — the agent drafts the action, a teammate approves it in one click, and the customer never sees the seam.',
  },
  {
    icon: '/img/value-boost.png',
    title: 'Every rescue teaches the agent',
    body: 'Recurring escalations cluster into knowledge gaps — Janis drafts the fix, you approve, and the same question never reaches a human twice.',
  },
  {
    icon: '/img/home-delight.png',
    title: 'Take over from Slack',
    body: 'Escalations arrive with an AI brief — reply in-thread, run it with /pause, /resume, /note, /teach.',
  },
  {
    icon: '/img/home-connect.png',
    title: 'Every channel, one inbox',
    body: 'Messenger, Instagram, WhatsApp, Slack, and web chat — unified, searchable, triageable.',
  },
  {
    icon: '/img/home-deploy.png',
    title: 'Hosted or bring-your-own',
    body: 'Run your agent inside Janis, or keep the one you built and connect it with a webhook.',
  },
  {
    icon: '/img/value-reduce.png',
    title: 'Know what it costs, always',
    body: 'Per-message pricing, token usage metered to the cent, unlimited seats and channels.',
  },
];

const DEPLOY_ON = ['Web chat', 'Messenger', 'Instagram', 'WhatsApp', 'Slack'];
// Mirrors the toolTemplates catalog — keep in sync.
const ACT_IN = ['Shopify', 'Stripe', 'HubSpot', 'Zendesk', 'Salesforce', 'Cal.com'];

const DIFFERENT: [string, string, string][] = [
  ['Your agent', 'Rebuild it on their bot platform', 'Keep yours — or use ours'],
  ['The handoff', 'A bolted-on escape hatch', 'The core of the product'],
  ['When the AI needs to act', 'Executes unsupervised — or can’t', 'A human approves the action first'],
  ['When the AI fails', 'A dashboard shows you where', 'Janis drafts the fix for you'],
  ['Pricing', 'Per seat, per teammate', 'Per message + metered tokens'],
];

// Mirrors apps/api/src/lib/plans.ts — keep in sync until plans are exposed via a public endpoint.
const PRICING = [
  { name: 'Free', price: '$0', msgs: '250 messages included / month', note: 'Hard cap at the limit — never a surprise bill', cta: 'Start free' },
  { name: 'Starter', price: '$29', msgs: '2,000 messages included / month', note: 'then $8 per additional 1,000 messages' },
  { name: 'Pro', price: '$99', msgs: '20,000 messages included / month', note: 'then $5 per additional 1,000 messages', featured: true },
  { name: 'Scale', price: '$299', msgs: '100,000 messages included / month', note: 'then $3 per additional 1,000 messages' },
];

type Beat =
  | { kind: 'in' | 'out'; text: string }
  | { kind: 'card' }
  | { kind: 'flip' } // invisible beat — the card resolves before the agent replies
  | { kind: 'note'; text: string };

const SCRIPT: Beat[] = [
  { kind: 'in', text: 'Can I get a refund on my order?' },
  { kind: 'out', text: 'Absolutely — let me put that through for you.' },
  { kind: 'card' },
  { kind: 'flip' },
  { kind: 'out', text: 'Done — your refund for $49.00 is on its way. Anything else?' },
  { kind: 'note', text: 'The customer saw a seamless conversation. A teammate approved the action in one click.' },
];

const STEP_MS = 1700;
const HOLD_MS = 6000;

/** Scripted replay of the approval flow — loops forever. */
function DemoStrip() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setTimeout(
      () => setStep((s) => (s >= SCRIPT.length ? 0 : s + 1)),
      step >= SCRIPT.length ? HOLD_MS : STEP_MS,
    );
    return () => clearTimeout(t);
  }, [step]);

  const approved = step >= 4; // card flips to approved when the agent confirms
  return (
    <div className="demo-window">
      <div className="demo-header">
        <span className="demo-dot" /><span className="demo-dot" /><span className="demo-dot" />
        <span className="demo-title">Customer · Web chat</span>
      </div>
      <div className="demo-body">
        {SCRIPT.slice(0, step).map((b, i) =>
          b.kind === 'card' ? (
            <div key={i} className={`demo-card${approved ? ' approved' : ''}`}>
              <div className="demo-card-tool">propose_refund</div>
              <div className="demo-card-args">order #1042 · $49.00</div>
              {approved ? (
                <div className="demo-card-done">✓ Approved by Mike — ran successfully</div>
              ) : (
                <div className="demo-card-btns">
                  <span className="demo-btn primary">Approve &amp; run</span>
                  <span className="demo-btn">Deny</span>
                </div>
              )}
            </div>
          ) : b.kind === 'note' ? (
            <div key={i} className="demo-note">{b.text}</div>
          ) : b.kind === 'flip' ? null : (
            <div key={i} className={`demo-msg ${b.kind}`}>{b.text}</div>
          ),
        )}
      </div>
    </div>
  );
}

/** Public landing page — also satisfies the OAuth consent screen home URL. */
export default function Landing() {
  const { data } = useMe();
  const cta = data ? { to: '/conversations', label: 'Open console' } : { to: '/login', label: 'Get started' };
  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' });
    window.location.href = '/';
  };

  // Dogfood the web-chat widget on the marketing site. Same-origin so the
  // visitor's Janis session (when logged in) identifies them automatically;
  // on top of that we fetch a signed identity and hand it to the widget.
  useEffect(() => {
    const TOKEN = '7595ffbd-6b87-47ef-8b97-9228eb28042c';
    const s = document.createElement('script');
    s.src = '/widget.js';
    s.setAttribute('data-janis-token', TOKEN);
    s.async = true;
    s.onload = () => {
      fetch(`/chat/${TOKEN}/identity`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .then((id) => {
          if (id?.sig) (window as unknown as { Janis?: { identify: (u: unknown) => void } }).Janis?.identify(id);
        })
        .catch(() => {});
    };
    document.body.appendChild(s);
    return () => {
      s.remove();
      for (const id of ['janis-style', 'janis-bubble', 'janis-panel']) {
        document.getElementById(id)?.remove();
      }
    };
  }, []);

  return (
    <div className="landing">
      <header className="landing-nav">
        <img className="landing-logo" src="/img/janis-top.png" alt="Janis" />
        <Link className="btn" to={cta.to}>{cta.label}</Link>
      </header>

      <section className="landing-hero">
        <h1>AI and your team, working together.</h1>
        <p>
          Janis answers your customers 24/7 on Messenger, Instagram, WhatsApp,
          Slack, and web chat — and hands off to your team when it matters.
          Your AI proposes the refund; a human approves it. The customer never
          sees the seam.
        </p>
        <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
          <Link className="btn primary lg" to={cta.to}>{cta.label}</Link>
          {data ? (
            <a
              className="btn lg"
              href="/login"
              onClick={(e) => {
                e.preventDefault();
                void signOut();
              }}
            >
              Sign out
            </a>
          ) : (
            <a className="btn lg" href="/login">Sign in</a>
          )}
        </div>
        <p className="landing-fine">Free plan available · No credit card required</p>
      </section>

      <section className="landing-steps">
        <h2>Watch the handoff happen</h2>
        <p className="landing-sub">
          AI drafts the action. A human approves it. The customer just sees a fast answer.
        </p>
        <DemoStrip />
        <p className="landing-fine">
          Try it for real — ask the Janis bot in the corner for a refund and watch
          the approval card appear.
        </p>
      </section>

      <section className="landing-grid">
        {FEATURES.map((f) => (
          <div key={f.title} className="card landing-card">
            <img src={f.icon} alt="" className="landing-icon" />
            <strong>{f.title}</strong>
            <p className="muted">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="landing-steps">
        <h2>Works with what you already use</h2>
        <p className="landing-sub">
          Deploy where your customers are. Let your agent act in the tools your team runs on.
        </p>
        <div className="chip-rows">
          <div className="chip-row">
            <span className="chip-label">Deploy on</span>
            {DEPLOY_ON.map((n) => <span key={n} className="chip">{n}</span>)}
          </div>
          <div className="chip-row">
            <span className="chip-label">Agent acts in</span>
            {ACT_IN.map((n) => <span key={n} className="chip">{n}</span>)}
          </div>
        </div>
        <p className="landing-fine">
          Or connect your own agent — keep what you built, connect it with a webhook or the SDK.
        </p>
      </section>

      <section className="landing-steps">
        <h2>Your brand, not ours</h2>
        <div className="landing-brand">
          <div className="landing-brand-copy">
            <p className="muted">
              Colors, your logo, launcher position, greeting, suggested replies —
              the chat bubble should look like it belongs on your site, because it
              does. Agencies can put their client’s name on every conversation.
            </p>
          </div>
          <div className="brand-mock">
            <div className="brand-mock-head" style={{ background: '#f99157' }}>
              <span className="brand-mock-dot" /> Acme Co · replies instantly
            </div>
            <div className="brand-mock-body">
              <div className="demo-msg out" style={{ background: '#f99157' }}>
                Hi! How can we help today?
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-steps">
        <h2>Build once. Deploy everywhere.</h2>
        <p className="landing-sub">
          One agent — its knowledge, tone, tools, and escalation rules — answers
          everywhere. Configure it once; Janis carries it to every channel.
        </p>
        <div className="omni">
          <span className="chip strong">Your agent</span>
          <span className="omni-arrow">→</span>
          {DEPLOY_ON.map((n) => <span key={n} className="chip">{n}</span>)}
        </div>
      </section>

      <section className="landing-steps">
        <h2>Why Janis is different</h2>
        <div className="landing-compare">
          <table className="docs-table">
          <thead>
            <tr>
              <th />
              <th>Typical AI support tools</th>
              <th>Janis</th>
            </tr>
          </thead>
          <tbody>
            {DIFFERENT.map(([aspect, them, ours]) => (
              <tr key={aspect}>
                <td><strong>{aspect}</strong></td>
                <td className="muted">{them}</td>
                <td>{ours}</td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      </section>

      <section className="landing-pricing">
        <h2>Simple pricing</h2>
        <p className="muted" style={{ textAlign: 'center', margin: '0 0 24px' }}>
          Every plan includes the console, unlimited seats and channels, alerts, and digests.
          You pay for messages — not seats. LLM tokens run at cost + margin on our platform
          key — or bring your own key and the LLM line drops to $0.
        </p>
        <div className="landing-grid four">
          {PRICING.map((p) => (
            <div key={p.name} className={`card landing-card${p.featured ? ' featured' : ''}`}>
              <strong>{p.name}</strong>
              <div className="landing-price">
                {p.price}
                <span className="muted">/mo</span>
              </div>
              <p className="muted">{p.msgs}</p>
              <p className="muted landing-price-note">{p.note}</p>
              <Link className={`btn${p.featured ? ' primary' : ''}`} to={cta.to}>
                {p.cta ?? cta.label}
              </Link>
            </div>
          ))}
        </div>
        <p className="landing-fine">
          On Free we stop ingesting messages at the cap — upgrade any time to resume instantly.
        </p>
        <p className="landing-fine">
          Bring your own OpenAI-compatible LLM key (OpenAI, Gemini, …): tokens run on your
          provider account and Janis bills $0 for them — no markup, ever. You'll still see
          exact token counts in Billing.
        </p>
      </section>

      <section className="landing-cta">
        <h2>Give your agent a safety net.</h2>
        <p className="muted">Set up in minutes — connect a channel, and Janis starts watching.</p>
        <Link className="btn primary lg" to={cta.to}>{cta.label}</Link>
      </section>

      <SiteFooter />
    </div>
  );
}
