import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export interface UsageReport {
  plan: { key: string; name: string; included_messages: number; base_cents: number; overage_per_1k_cents: number | null };
  messages_used: number;
  messages_remaining: number;
  current: { period: string; llm_prompt_tokens: number; llm_completion_tokens: number; llm_cost_usd: number; voice_seconds: number };
  previous: { period: string; llm_prompt_tokens: number; llm_completion_tokens: number; llm_cost_usd: number; voice_seconds: number };
}

/** Usage — this billing period against the plan. `agentId` narrows the
 *  rollup for the agent-scoped view (messages + LLM/voice burn on that
 *  agent only); the plan line stays workspace-wide. */
export function UsageCard({ agentId }: { agentId?: string }) {
  const usage = useQuery({
    queryKey: ['usage-metrics', agentId ?? ''],
    queryFn: () => api<UsageReport>(`/api/reports/usage${agentId ? `?agent_id=${agentId}` : ''}`),
  });
  const u = usage.data;
  if (!u) return null;
  const capped = u.plan.included_messages >= Number.MAX_SAFE_INTEGER;
  const pct = capped ? 0 : Math.min(100, Math.round((u.messages_used / u.plan.included_messages) * 100));
  const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
  const fmtSec = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`);
  return (
    <div className="card">
      <div className="row">
        <strong className="grow">Usage — {u.current.period} · {u.plan.name} plan</strong>
      </div>
      <div className="metric-grid" style={{ marginTop: 10 }}>
        <div className="metric">
          <div className="metric-num">
            {u.messages_used.toLocaleString()}
            {!capped && <span className="muted" style={{ fontSize: 14 }}> / {u.plan.included_messages.toLocaleString()}</span>}
          </div>
          <div className="muted">messages this period{capped ? ' (uncapped plan)' : ''}</div>
        </div>
        <div className="metric"><div className="metric-num">{fmtUsd(u.current.llm_cost_usd)}</div><div className="muted">LLM cost (prev {fmtUsd(u.previous.llm_cost_usd)})</div></div>
        <div className="metric"><div className="metric-num">{((u.current.llm_prompt_tokens + u.current.llm_completion_tokens) / 1000).toFixed(0)}k</div><div className="muted">LLM tokens</div></div>
        <div className="metric"><div className="metric-num">{fmtSec(u.current.voice_seconds)}</div><div className="muted">voice (prev {fmtSec(u.previous.voice_seconds)})</div></div>
      </div>
      {!capped && (
        <div style={{ marginTop: 10, background: 'var(--panel-2)', borderRadius: 3, height: 8 }}>
          <div style={{
            width: `${pct}%`, height: '100%', borderRadius: 3,
            background: pct > 90 ? 'var(--danger, #e5534b)' : 'var(--accent)',
          }} />
        </div>
      )}
    </div>
  );
}
