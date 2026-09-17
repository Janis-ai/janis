import { Link } from 'react-router-dom';
import { useMe } from '../api/hooks';

const FEATURES = [
  {
    icon: '/img/home-connect.png',
    title: 'Connect every channel',
    body: 'Facebook, Instagram, WhatsApp, and Slack in a couple of clicks. Your customers message where they already are — you see it all in one place.',
  },
  {
    icon: '/img/home-deploy.png',
    title: 'Hosted or bring-your-own',
    body: 'Run your agent inside Janis with your knowledge base, or keep the agent you built and connect it with a webhook. Oversight works the same either way.',
  },
  {
    icon: '/img/home-delight.png',
    title: 'Delight around the clock',
    body: 'The agent answers instantly, 24/7. When it can’t, a human joins with full context — the customer never repeats themselves.',
  },
];

const VALUES = [
  {
    icon: '/img/value-reduce.png',
    title: 'Cut support costs',
    body: 'The agent absorbs the volume; your team only touches conversations that need judgment. Pay for exactly the tokens you use — no per-seat pricing games.',
  },
  {
    icon: '/img/value-boost.png',
    title: 'Boost coverage',
    body: 'Every message gets an answer — at 3pm and 3am. Escalations come with an AI-written brief, so nobody starts cold.',
  },
  {
    icon: '/img/value-delight.png',
    title: 'Delight customers',
    body: 'No dead ends, no “sorry, I can’t help with that.” A person steps in the moment it matters — then the agent picks right back up.',
  },
];

const STEPS = [
  ['Connect', 'Link your channels and your agent — hosted on Janis or your own.'],
  ['Agent answers', 'Customers get instant replies with your knowledge base behind it.'],
  ['Human steps in', 'When the agent is stuck, the alert lands in Slack with the full transcript. Take over in one click.'],
  ['Hand it back', 'Resolve, resume the agent, and the thread keeps flowing. Nothing is lost.'],
];

/** Public landing page — also satisfies the OAuth consent screen home URL. */
export default function Landing() {
  const { data } = useMe();
  const cta = data ? { to: '/conversations', label: 'Open console' } : { to: '/login', label: 'Get started' };

  return (
    <div className="landing">
      <header className="landing-nav">
        <img className="landing-logo" src="/img/janis-top.png" alt="Janis" />
        <Link className="btn" to={cta.to}>{cta.label}</Link>
      </header>

      <section className="landing-hero">
        <h1>Your AI agent has a help button.</h1>
        <p>
          Janis watches your customer conversations on Messenger, Instagram, WhatsApp, and
          Slack — and hands them to a human the moment your agent gets stuck. Answers 24/7,
          people when it matters.
        </p>
        <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
          <Link className="btn primary lg" to={cta.to}>{cta.label}</Link>
          <a className="btn lg" href="/login">Sign in</a>
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

      <section className="landing-grid">
        {VALUES.map((v) => (
          <div key={v.title} className="card landing-card">
            <img src={v.icon} alt="" className="landing-icon" />
            <strong>{v.title}</strong>
            <p className="muted">{v.body}</p>
          </div>
        ))}
      </section>

      <section className="landing-cta">
        <h2>Give your agent a safety net.</h2>
        <p className="muted">Set up in minutes — connect a channel, and Janis starts watching.</p>
        <Link className="btn primary lg" to={cta.to}>{cta.label}</Link>
      </section>

      <footer className="landing-footer muted">
        <img src="/img/janis-logo-bot.png" alt="Janis" style={{ height: 20, opacity: 0.8 }} />
        <span>© {new Date().getFullYear()} Janis</span>
        <Link to="/privacy">Privacy Policy</Link>
        <Link to="/terms">Terms of Service</Link>
      </footer>
    </div>
  );
}
