import { Link } from 'react-router-dom';
import { useMe } from '../api/hooks';

/** Public landing page — also satisfies the OAuth consent screen home URL. */
export default function Landing() {
  const { data } = useMe();
  return (
    <div className="login-wrap" style={{ display: 'block' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '28px 24px 60px' }}>
        <div className="row" style={{ padding: '8px 0 48px' }}>
          <strong className="grow" style={{ color: 'var(--accent)', fontSize: 20 }}>Janis</strong>
          <Link className="btn" to={data ? '/inbox' : '/login'}>
            {data ? 'Open console' : 'Sign in'}
          </Link>
        </div>

        <h1 style={{ fontSize: 40, lineHeight: 1.15, margin: '0 0 16px', letterSpacing: '-1px' }}>
          Human backup for your AI agents.
        </h1>
        <p className="muted" style={{ fontSize: 17, lineHeight: 1.55, margin: '0 0 32px' }}>
          Janis puts your customer conversations on Messenger, Instagram, WhatsApp, and Slack
          in one inbox — and hands them to a human the moment your agent gets stuck.
        </p>
        <div className="row">
          <Link className="btn primary" to={data ? '/inbox' : '/login'}>
            {data ? 'Open console' : 'Get started'}
          </Link>
        </div>

        <div className="row" style={{ marginTop: 48, alignItems: 'stretch', gap: 12 }}>
          {[
            ['Take over live', 'Watch the agent work. One click pauses it and puts a human in the thread — resume when you’re done.'],
            ['Every channel', 'Facebook, Instagram, WhatsApp, and Slack connect in a couple of clicks. No code on your side.'],
            ['Hosted agents', 'We run the agent for you — plug in your knowledge base and your POS or CRM tools. Pay for what it uses.'],
          ].map(([title, body]) => (
            <div key={title} className="card" style={{ flex: 1, minWidth: 180 }}>
              <strong>{title}</strong>
              <div className="muted" style={{ marginTop: 6, fontSize: 14, lineHeight: 1.5 }}>{body}</div>
            </div>
          ))}
        </div>

        <div className="muted" style={{ marginTop: 64, fontSize: 13, display: 'flex', gap: 20 }}>
          <span>© {new Date().getFullYear()} Janis</span>
          <Link to="/privacy">Privacy Policy</Link>
          <Link to="/terms">Terms of Service</Link>
        </div>
      </div>
    </div>
  );
}
