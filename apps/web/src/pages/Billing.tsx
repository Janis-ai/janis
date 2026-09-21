import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

interface BillingSummary {
  period: string;
  stripe_enabled: boolean;
  has_billing_account: boolean;
  plans: {
    key: string;
    name: string;
    base_cents: number;
    included_messages: number;
    overage_per_1k_cents: number | null;
    purchasable: boolean;
  }[];
  plan: {
    key: string;
    name: string;
    base_cents: number;
    included_messages: number;
    capped: boolean;
    covered_by?: { name?: string; contact?: string } | null;
  };
  messages: { used: number; included: number; overage: number; overage_cents: number };
  tokens: { prompt: number; completion: number; total: number };
  llm_calls: number;
  channels_connected: number;
  costs: {
    plan_cents: number;
    message_overage_cents: number;
    channel_cents: number;
    llm_cents: number;
    margin_cents: number;
    margin_pct: number;
    total_cents: number;
  };
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
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const qc = useQueryClient();
  const [upgraded, setUpgraded] = useState(
    () => new URLSearchParams(window.location.search).has('upgraded'),
  );
  const { data } = useQuery({
    queryKey: ['billing', period],
    queryFn: () => api<BillingSummary>(`/api/billing/summary?period=${period}`),
    refetchInterval: upgraded ? 3000 : false, // poll until the webhook lands
  });

  useEffect(() => {
    if (data && upgraded && data.plan.key !== 'free') setUpgraded(false);
  }, [data, upgraded]);

  const checkout = async (plan: string) => {
    setError('');
    try {
      const r = await api<{ url: string }>('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan }),
      });
      window.location.href = r.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'checkout failed');
    }
  };

  const portal = async () => {
    setError('');
    try {
      const r = await api<{ url: string }>('/api/billing/portal', { method: 'POST' });
      window.location.href = r.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'portal failed');
    }
  };

  const downgrade = async () => {
    setError('');
    setNotice('');
    if (!window.confirm('Move to the Free plan?')) return;
    try {
      const r = await api<{ at_period_end: boolean }>('/api/billing/downgrade', { method: 'POST' });
      setNotice(
        r.at_period_end
          ? 'Subscription will cancel at the end of the paid period — your plan stays active until then.'
          : 'You are now on the Free plan.',
      );
      void qc.invalidateQueries({ queryKey: ['billing'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'downgrade failed');
    }
  };

  const pct = data ? Math.min(100, (data.messages.used / data.messages.included) * 100) : 0;

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

      {upgraded && data?.plan.key === 'free' && (
        <div className="card muted">Checkout complete — waiting for Stripe to confirm…</div>
      )}
      {data?.plan.covered_by && (
        <div className="card muted">
          Your account is covered by <strong>{data.plan.covered_by.name ?? 'an agency plan'}</strong>
          {data.plan.covered_by.contact && (
            <>
              {' '}— contact <strong>{data.plan.covered_by.contact}</strong> to add agents or make changes
            </>
          )}
          . You can also subscribe to a plan of your own below.
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {notice && <div className="card muted">{notice}</div>}

      {data && (
        <>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Plan</h3>
            <div className="plan-grid">
              {data.plans.map((p) => {
                const current = p.key === data.plan.key;
                return (
                  <div
                    key={p.key}
                    style={{
                      border: `1px solid ${current ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 8,
                      padding: 12,
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>{p.name}</div>
                    <div className="mono" style={{ fontSize: 20, margin: '4px 0' }}>
                      {usd(p.base_cents)}<span className="muted" style={{ fontSize: 12 }}>/mo</span>
                    </div>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {p.included_messages.toLocaleString()} messages/mo
                      <br />
                      {p.overage_per_1k_cents === null
                        ? 'hard cap beyond limit'
                        : `${usd(p.overage_per_1k_cents)}/1k over`}
                    </div>
                    {current ? (
                      <div className="muted" style={{ marginTop: 10 }}>Current plan</div>
                    ) : p.key === 'free' ? (
                      <button className="btn" style={{ marginTop: 10 }} onClick={() => void downgrade()}>
                        Downgrade
                      </button>
                    ) : p.purchasable ? (
                      <button
                        className="btn primary"
                        style={{ marginTop: 10 }}
                        onClick={() => void checkout(p.key)}
                      >
                        {data.plan.base_cents < p.base_cents ? 'Upgrade' : 'Switch'}
                      </button>
                    ) : (
                      <div className="muted" style={{ marginTop: 10 }}>Contact us</div>
                    )}
                  </div>
                );
              })}
            </div>
            {data.stripe_enabled && data.has_billing_account && (
              <div style={{ marginTop: 12 }}>
                <button className="btn" onClick={() => void portal()}>
                  Manage payment method &amp; invoices
                </button>
              </div>
            )}
          </div>

          <div className="card">
            <div className="row" style={{ alignItems: 'baseline' }}>
              <h3 className="grow" style={{ marginTop: 0 }}>
                {data.plan.name} plan — {usd(data.plan.base_cents)}/mo
              </h3>
              {data.plan.capped && (
                <span className="muted">hard cap — bot stops answering, messages dropped past the limit</span>
              )}
            </div>
            <div className="muted" style={{ marginBottom: 6 }}>
              {data.messages.used.toLocaleString()} / {data.messages.included.toLocaleString()} messages
              {data.messages.overage > 0 &&
                ` · ${data.messages.overage.toLocaleString()} over`}
            </div>
            <div style={{ height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${pct}%`,
                  background: pct >= 100 ? 'var(--danger, #e5484d)' : 'var(--accent)',
                  transition: 'width .3s',
                }}
              />
            </div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Estimated invoice — {data.period}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 24px', maxWidth: 440 }}>
              <span>{data.plan.name} plan</span>
              <span className="mono">{usd(data.costs.plan_cents)}</span>
              <span className="muted">
                Message overage ({data.messages.overage.toLocaleString()} beyond {data.messages.included.toLocaleString()} included)
              </span>
              <span className="mono">{usd(data.costs.message_overage_cents)}</span>
              <span className="muted">Channels ({data.channels_connected} connected)</span>
              <span className="mono">{usd(data.costs.channel_cents)}</span>
              <span className="muted">
                LLM pass-through ({data.llm_calls} calls, {data.tokens.total.toLocaleString()} tokens)
              </span>
              <span className="mono">{usd(data.costs.llm_cents)}</span>
              <span className="muted">LLM margin ({data.costs.margin_pct}%)</span>
              <span className="mono">{usd(data.costs.margin_cents)}</span>
              <strong style={{ borderTop: '1px solid var(--border)' }}>Total</strong>
              <strong className="mono" style={{ borderTop: '1px solid var(--border)' }}>
                {usd(data.costs.total_cents)}
              </strong>
            </div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>LLM usage by agent</h3>
            {data.by_agent.length === 0 && (
              <div className="muted">No metered LLM usage this period.</div>
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
            Every stored message counts toward the plan — user, agent, and human replies alike.
            On a capped plan the bot stops answering past the limit and new inbound
            messages are dropped — not transcribed — until the next billing period or an upgrade.
            LLM tokens are metered on calls Janis makes (hosted agents, suggestions) and passed
            through at cost + {data.costs.margin_pct}%.
          </div>
        </>
      )}
    </>
  );
}
