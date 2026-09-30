import { useState } from 'react';
import { api } from '../api/client';
import { useMe } from '../api/hooks';
import { railBus } from '../lib/railBus';

interface Card {
  key: string;
  title: string;
  body: string;
  question: string;
}

// Differentiator order — the story the product leads with.
const CARDS: Card[] = [
  {
    key: 'approvals',
    title: 'AI proposes, you approve',
    body: 'Refunds, plan changes, data edits — gated actions wait for a human click.',
    question: 'How do approval-gated actions work?',
  },
  {
    key: 'takeover',
    title: 'Human takeover',
    body: 'Jump into any live conversation; hand it back when you\u2019re done.',
    question: 'How does human takeover work in Janis?',
  },
  {
    key: 'instant',
    title: 'Instant AI',
    body: 'Replies in seconds, 24/7, on every channel at once.',
    question: 'How fast does the agent reply?',
  },
  {
    key: 'tools',
    title: 'Connect your tools',
    body: 'Shopify, Stripe, HubSpot, Zendesk, Cal.com — or your own APIs.',
    question: 'What tools and integrations can my agent use?',
  },
  {
    key: 'channels',
    title: 'Deploy everywhere',
    body: 'Web chat, Messenger, Instagram, WhatsApp, SMS, email — one agent.',
    question: 'What channels can I deploy Janis on?',
  },
  {
    key: 'branding',
    title: 'Your brand, not ours',
    body: 'Colors, greeting, logo, tone — the widget wears your brand.',
    question: 'Can I customize the chat widget branding?',
  },
];

const DISMISS_KEY = 'janis_discovery_dismissed';

/** Feature tour cards on the inbox — each opens Ask Janis with a seeded
 *  question so the answer is the concierge's, not a static blurb. */
export default function DiscoveryCards() {
  const { data: me } = useMe();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === '1',
  );
  const channelId = me?.support_channel_id;
  if (!channelId) return null;

  if (dismissed) {
    return (
      <button
        className="btn"
        style={{ marginBottom: 16, fontSize: 12 }}
        onClick={() => {
          localStorage.removeItem(DISMISS_KEY);
          setDismissed(false);
        }}
      >
        New here? Take a tour →
      </button>
    );
  }

  const click = (c: Card) => {
    void api('/api/track', {
      method: 'POST',
      body: JSON.stringify({ event: 'discovery_card_click', meta: { card: c.key } }),
    }).catch(() => {});
    railBus.publish({ channelId, label: 'Ask Janis', seed: c.question });
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row">
        <strong className="grow">What Janis can do</strong>
        <button
          className="btn icon"
          title="Dismiss"
          aria-label="Dismiss discovery cards"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, '1');
            setDismissed(true);
            void api('/api/track', {
              method: 'POST',
              body: JSON.stringify({ event: 'discovery_card_dismissed' }),
            }).catch(() => {});
          }}
        >
          ×
        </button>
      </div>
      <div className="discovery-grid">
        {CARDS.map((c) => (
          <button key={c.key} className="discovery-card" onClick={() => click(c)}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.title}</div>
            <div className="muted" style={{ fontSize: 12 }}>{c.body}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
