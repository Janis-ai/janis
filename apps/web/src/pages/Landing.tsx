import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useMe } from '../api/hooks';
import { api } from '../api/client';
import { SiteFooter } from '../components/bits';

const FEATURES = [
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
    icon: '/img/home-delight.png',
    title: 'Take over from Slack',
    body: 'Escalations arrive with an AI brief — reply in-thread, run it with /pause, /resume, /note, /teach.',
  },
  {
    icon: '/img/value-boost.png',
    title: 'Every rescue teaches the agent',
    body: 'Recurring escalations cluster into knowledge gaps — Janis drafts the fix, you approve.',
  },
  {
    icon: '/img/value-delight.png',
    title: 'A handoff that feels human',
    body: 'Typing indicators, receipts, operator personas — customers see a person, not a broken bot.',
  },
  {
    icon: '/img/value-reduce.png',
    title: 'Know what it costs, always',
    body: 'Per-message pricing, token usage metered to the cent, unlimited seats and channels.',
  },
];

const DIFFERENT: [string, string, string][] = [
  ['Your agent', 'Rebuild it on their bot platform', 'Keep yours — or use ours'],
  ['The handoff', 'A bolted-on escape hatch', 'The core of the product'],
  ['When the AI fails', 'A dashboard shows you where', 'Janis drafts the fix for you'],
  ['Pricing', 'Per seat, per teammate', 'Per message + metered tokens'],
];

// Mirrors apps/api/src/lib/plans.ts — keep in sync until plans are exposed via a public endpoint.
const PRICING = [
  { name: 'Free', price: '$0', msgs: '250 messages/mo', note: 'Hard cap at the limit — never a surprise bill', cta: 'Start free' },
  { name: 'Starter', price: '$29', msgs: '2,000 messages/mo', note: 'then $8 per 1,000' },
  { name: 'Pro', price: '$99', msgs: '20,000 messages/mo', note: 'then $5 per 1,000', featured: true },
  { name: 'Scale', price: '$299', msgs: '100,000 messages/mo', note: 'then $3 per 1,000' },
];

const STEPS = [
  ['Connect', 'Link your channels and your agent — hosted on Janis or your own webhook.'],
  ['Agent answers', 'Instant replies grounded in your knowledge base, 24/7.'],
  ['Human steps in', 'Slack alert with an AI brief — reply in-thread and you’re talking to the customer.'],
  ['Hand it back', 'Resume the agent; the exchange becomes training data.'],
];

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
        <h1>Your AI agent has a help button.</h1>
        <p>
          Janis is the oversight layer for AI agents. It answers your customers on
          Messenger, Instagram, WhatsApp, Slack, and web chat — hands off to a human
          when it matters, and learns from every rescue.
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
        <h2>How it works</h2>
        <div className="landing-grid four">
          {STEPS.map(([title, body], i) => (
            <div key={title} className="landing-step">
              <div className="landing-stepnum">{i + 1}</div>
              <strong>{title}</strong>
              <p className="muted">{body}</p>
            </div>
          ))}
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
