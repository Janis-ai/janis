import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useMe } from '../api/hooks';
import { api } from '../api/client';
import { SiteFooter } from '../components/bits';

// Inline stroke glyphs — the old PNG set only had three distinct images,
// which read as copy-paste once six cards sat side by side.
const GLYPHS = {
  inbox: (
    <>
      <path d="M21 12l-3.5-7h-11L3 12v7h18v-7z" />
      <path d="M3 12h5a4 4 0 008 0h5" />
    </>
  ),
  plug: (
    <>
      <path d="M9 7V4m6 3V4" />
      <path d="M7 7h10v5a5 5 0 01-10 0V7z" />
      <path d="M12 17v4" />
    </>
  ),
  handover: (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M3 21v-1a6 6 0 016-6 6 6 0 016 6v1" />
      <path d="M16 9l2 2 4-4" />
    </>
  ),
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h13l-3 4 3 4H5" />
    </>
  ),
  loop: (
    <>
      <path d="M20 8A9 9 0 005.6 5.6L3 8" />
      <path d="M3 3v5h5" />
      <path d="M4 16a9 9 0 0014.4 2.4L21 16" />
      <path d="M21 21v-5h-5" />
    </>
  ),
  headset: (
    <>
      <path d="M4 14v-2a8 8 0 0116 0v2" />
      <rect x="3" y="13" width="4" height="6" rx="1.5" />
      <rect x="17" y="13" width="4" height="6" rx="1.5" />
      <path d="M20 19a3 3 0 01-3 2h-3" />
    </>
  ),
} as const;

function Icon({ name }: { name: keyof typeof GLYPHS }) {
  return (
    <svg
      className="landing-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {GLYPHS[name]}
    </svg>
  );
}

const FEATURES = [
  {
    icon: 'inbox',
    title: 'Every channel, one inbox',
    body: 'Messenger, Instagram, WhatsApp, email, and web chat — unified, searchable, triageable.',
  },
  {
    icon: 'plug',
    title: 'Hosted or bring-your-own',
    body: 'Run your agent inside Janis, or keep the one you built and connect it with a webhook.',
  },
  {
    icon: 'handover',
    title: 'Take over from anywhere',
    body: 'Escalations land with an AI brief. Step in from the Janis console — or reply in Slack right in the thread and the customer sees you, not a bot.',
  },
  {
    icon: 'flag',
    title: 'Autonomous, with checkpoints',
    body: 'Agents reply and run tools unattended. Mark an action approval-required — refunds, plan changes — and it waits for a human click.',
  },
  {
    icon: 'loop',
    title: 'Every rescue teaches the agent',
    body: 'Recurring escalations cluster into knowledge gaps — Janis drafts the fix, you approve.',
  },
  {
    icon: 'headset',
    title: 'A handoff that feels human',
    body: 'Typing indicators, receipts, operator personas — customers see a person, not a broken bot.',
  },
] as const;

const DIFFERENT: [string, string, string][] = [
  ['Your agent', 'Rebuild it on their bot platform', 'Keep yours — or use ours'],
  ['Autonomy', 'All-or-nothing, decided globally', 'Full speed — checkpoints where you draw them'],
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
  ['Human steps in', 'An alert lands with an AI brief — take over in the console or straight from Slack, and approve gated actions inline.'],
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
        <nav className="landing-nav-links">
          <a href="#how">How it works</a>
          <a href="#pricing">Pricing</a>
          <Link to="/docs">Developer docs</Link>
        </nav>
        <Link className="btn" to={cta.to}>{cta.label}</Link>
      </header>

      <section className="landing-hero">
        <h1>Your AI agent has a help button.</h1>
        <p>
          Let AI handle customer conversations across every channel. When it
          needs help — or your approval — a human steps in, and your agent
          picks up right where it left off.
        </p>
        <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
          <Link className="btn primary lg" to={cta.to}>{data ? 'Open console' : 'Get started free'}</Link>
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
            <a className="btn lg" href="#how">See how it works</a>
          )}
        </div>
        <p className="landing-fine">Free plan available · No credit card required</p>
        <p className="landing-try">
          Try it now — the chat bubble in the corner is Janis, running on Janis.
        </p>
      </section>

      <section className="landing-shot">
        <figure>
          <img
            src="/img/landing-takeover.png"
            alt="The Janis console: the hosted agent answers a customer's shipping question, an operator takes over with one click, and the agent stands by to resume."
          />
          <figcaption className="muted">
            A real takeover — the agent answers, an operator steps in from the
            console (or Slack), then the agent resumes when the human is done.
          </figcaption>
        </figure>
      </section>

      <section className="landing-grid">
        {FEATURES.map((f) => (
          <div key={f.title} className="card landing-card">
            <Icon name={f.icon} />
            <strong>{f.title}</strong>
            <p className="muted">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="landing-steps" id="how">
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

      <section className="landing-pricing" id="pricing">
        <h2>Simple pricing</h2>
        <p className="muted" style={{ textAlign: 'center', margin: '0 0 24px' }}>
          Every plan includes the console, unlimited seats and channels, alerts, and digests.
          You pay for messages — not seats. LLM tokens are metered at provider rates on
          our platform key — or bring your own key and the LLM line drops to $0.
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
          provider account and Janis bills $0 for them. You'll still see
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
