import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

interface BillingSummary {
  period: string;
  tokens: { prompt: number; completion: number; total: number };
  llm_calls: number;
  costs: {
    usage_cents: number;
    infra_cents: number;
    subtotal_cents: number;
    margin_cents: number;
    margin_pct: number;
    total_cents: number;
  };
  channels_connected: number;
  by_agent: {
    agent_id: string | null;
    agent_name: string;
    tokens: number;
    llm_calls: number;
    cost_cents: number;
  }[];
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function Billing() {
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const { data } = useQuery({
    queryKey: ['billing', period],
    queryFn: () => api<BillingSummary>(`/api/billing/summary?period=${period}`),
  });

  return (
    <>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 className="page-title grow">Billing</h1>
        <input
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          style={{ width: 'auto' }}
        />
      </div>

      {data && (
        <>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Estimated invoice — {data.period}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 24px', maxWidth: 420 }}>
              <span className="muted">LLM usage ({data.llm_calls} calls, {data.tokens.total.toLocaleString()} tokens)</span>
              <span className="mono">{usd(data.costs.usage_cents)}</span>
              <span className="muted">Infrastructure share</span>
              <span className="mono">{usd(data.costs.infra_cents - data.channels_connected * 0 /* base+channels shown combined */)}</span>
              <span className="muted" style={{ paddingLeft: 12 }}>incl. {data.channels_connected} connected channel{data.channels_connected === 1 ? '' : 's'}</span>
              <span />
              <span style={{ borderTop: '1px solid var(--border)' }}>Subtotal</span>
              <span className="mono" style={{ borderTop: '1px solid var(--border)' }}>{usd(data.costs.subtotal_cents)}</span>
              <span className="muted">Margin ({data.costs.margin_pct}%)</span>
              <span className="mono">{usd(data.costs.margin_cents)}</span>
              <strong>Total</strong>
              <strong className="mono">{usd(data.costs.total_cents)}</strong>
            </div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Usage by agent</h3>
            {data.by_agent.length === 0 && (
              <div className="muted">No metered usage this period — hosted-agent LLM calls and suggestions show up here.</div>
            )}
            {data.by_agent.map((a) => (
              <div key={a.agent_id ?? 'none'} className="row" style={{ marginTop: 6 }}>
                <span className="grow">{a.agent_name}</span>
                <span className="muted">{a.llm_calls} calls · {a.tokens.toLocaleString()} tokens</span>
                <span className="mono" style={{ width: 80, textAlign: 'right' }}>{usd(a.cost_cents)}</span>
              </div>
            ))}
          </div>

          <div className="card muted" style={{ fontSize: 13 }}>
            Token usage is metered on every LLM call Janis makes — hosted-agent replies and
            reply suggestions — priced at the provider rate card, then your infra share and
            margin are added. Agents running on their own keys don't appear here.
          </div>
        </>
      )}
    </>
  );
}
