import { Navigate, useNavigate } from 'react-router-dom';
import { Bot, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { useAgents, useMe } from '../api/hooks';
import { BrandImg } from '../components/bits';
import { DISCOVERY_CARDS } from '../components/DiscoveryCards';
import { railBus } from '../lib/railBus';
import { usePageTitle } from '../lib/title';

/** First-run landing — a workspace with zero agents has nothing to inbox,
 *  so /conversations redirects here: the create-agent CTA sits front and
 *  center, with the concierge one click away and the discovery tour
 *  underneath. Once an agent exists the page bounces to the inbox. */
export default function Welcome() {
  usePageTitle('Welcome');
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { data: agents } = useAgents();
  const channelId = me?.support_channel_id;

  if (agents && agents.agents.length > 0) {
    return <Navigate to="/conversations" replace />;
  }

  const ask = (seed: string, card?: string) => {
    void api('/api/track', {
      method: 'POST',
      body: JSON.stringify({
        event: card ? 'discovery_card_click' : 'welcome_copilot_cta',
        ...(card ? { meta: { card } } : {}),
      }),
    }).catch(() => {});
    if (channelId) railBus.publish({ channelId, label: 'Ask Janis', seed });
  };

  return (
    <div className="welcome">
      <div className="card welcome-hero">
        <BrandImg className="brand-wide" alt="Janis" />
        <h1>Let's build your first agent</h1>
        <p className="muted" style={{ maxWidth: '52ch' }}>
          Janis answers your customers on web chat, WhatsApp, Messenger,
          Instagram, SMS and email — with your tools, your knowledge, and a
          human approve button wherever you want one.
        </p>
        <div className="row" style={{ gap: 8, justifyContent: 'center', marginTop: 12 }}>
          <button className="btn primary lg" onClick={() => navigate('/agents/new')}>
            <Bot size={16} /> Create your first agent
          </button>
          {channelId && (
            <button className="btn lg" onClick={() => ask('Help me build my first agent')}>
              <Sparkles size={16} /> Ask Janis to build it with you
            </button>
          )}
        </div>
      </div>
      <div className="muted" style={{ margin: '18px 0 2px', fontSize: 13 }}>
        What Janis can do — tap one and the copilot explains:
      </div>
      <div className="discovery-grid">
        {DISCOVERY_CARDS.map((c) => (
          <button key={c.key} className="discovery-card" onClick={() => ask(c.question, c.key)}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.title}</div>
            <div className="muted" style={{ fontSize: 12 }}>{c.body}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
