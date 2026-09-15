import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

interface Step {
  key: string;
  label: string;
  hint: string;
  done: boolean;
}

const STEP_LINKS: Record<string, string> = {
  create_agent: '/agents',
  agent_live: '/agents',
  add_channel: '/integrations',
  first_message: '/integrations',
  take_over: '/channels',
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
