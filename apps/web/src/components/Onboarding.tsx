import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAgents } from '../api/hooks';
import { trackOnce } from '../lib/analytics';

interface Step {
  key: string;
  label: string;
  hint: string;
  done: boolean;
}

// Server-observed milestones → GA4 funnel events. trackOnce dedups per
// browser so the 30s poll doesn't re-fire on every refetch.
const STEP_EVENTS: Record<string, string> = {
  create_agent: 'first_agent',
  agent_live: 'agent_online',
  add_channel: 'channel_connected',
  first_message: 'first_conversation',
  take_over: 'first_takeover',
};

/** Setup checklist shown on the inbox until every step is done (or dismissed). */
export default function Onboarding() {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('janis_onboarding_dismissed') === '1',
  );
  const { data } = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api<{ steps: Step[]; complete: boolean }>('/api/onboarding'),
    refetchInterval: 30_000,
  });
  const { data: agents } = useAgents();

  useEffect(() => {
    if (!data) return;
    for (const s of data.steps) {
      const event = STEP_EVENTS[s.key];
      if (s.done && event) trackOnce(`step:${s.key}`, event);
    }
    if (data.complete) trackOnce('onboarding_complete', 'onboarding_complete');
  }, [data]);

  // Channel steps land on the first agent's Channels tab (management is per-agent now).
  const channelsLink = agents?.agents[0]
    ? `/agents/${agents.agents[0].id}?tab=channels`
    : '/agents';
  const STEP_LINKS: Record<string, string> = {
    create_agent: '/agents',
    agent_live: '/agents',
    add_channel: channelsLink,
    first_message: channelsLink,
    take_over: '/conversations',
  };

  if (dismissed || !data || data.complete) return null;

  const doneCount = data.steps.filter((s) => s.done).length;

  return (
    <div className="card onboarding">
      <div className="row">
        <strong className="grow">Get your first supervised conversation</strong>
        <span className="muted">{doneCount}/{data.steps.length}</span>
        <button
          className="btn icon"
          title="Dismiss"
          aria-label="Dismiss onboarding checklist"
          onClick={() => {
            localStorage.setItem('janis_onboarding_dismissed', '1');
            setDismissed(true);
          }}
        >
          ×
        </button>
      </div>
      <div className="steps">
        {data.steps.map((s) => (
          <div key={s.key} className={`step ${s.done ? 'done' : ''}`}>
            <span className="step-check">{s.done ? '✓' : ''}</span>
            <div className="grow">
              <div>{s.label}</div>
              {!s.done && <div className="muted">{s.hint}</div>}
            </div>
            {!s.done && STEP_LINKS[s.key] && (
              <Link className="btn" to={STEP_LINKS[s.key]}>Go</Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
