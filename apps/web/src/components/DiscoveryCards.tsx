import { useState } from 'react';
import { api } from '../api/client';
import { useMe } from '../api/hooks';
import { railBus } from '../lib/railBus';

export interface DiscoveryCard {
  key: string;
  title: string;
  body: string;
  question: string;
}

// Differentiator order — the story the product leads with. Every question
// seeds Ask Janis, so it must be something the concierge KB covers.
export const DISCOVERY_CARDS: DiscoveryCard[] = [
  {
    key: 'approvals',
    title: 'AI proposes, you approve',
    body: 'Refunds, plan changes, data edits — gated actions wait for a human click.',
    question: 'How do approval-gated actions work?',
  },
  {
    key: 'copilot',
    title: 'A copilot that builds with you',
    body: 'Ask Janis writes prompts, teaches knowledge, wires tools — a teammate inside the console.',
    question: 'What can the Ask Janis copilot do for me?',
  },
  {
    key: 'evals',
    title: 'Tested before customers see it',
    body: 'Scenario suites replay your agent on every change — regressions surface before they ship.',
    question: 'How do scenario tests and eval runs work?',
  },
  {
    key: 'alerts',
    title: 'Alerts that route themselves',
    body: 'Escalation rules, SLA re-alerts, and auto-assign put the right person on it — Slack included.',
    question: 'How do escalation alerts and routing work?',
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

  const click = (c: DiscoveryCard) => {
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
        {DISCOVERY_CARDS.map((c) => (
          <button key={c.key} className="discovery-card" onClick={() => click(c)}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.title}</div>
            <div className="muted" style={{ fontSize: 12 }}>{c.body}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
