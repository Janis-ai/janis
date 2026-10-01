import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAgents, useChannels, useDigests } from '../api/hooks';
import { Empty, channelLabel } from '../components/bits';
import { usePageTitle } from '../lib/title';

interface HandoffMetrics {
  days: number;
  handoffs: number;
  responded: number;
  response_rate: number | null;
  avg_first_response_min: number | null;
  median_first_response_min: number | null;
  unresolved: number;
  overdue: number;
  stale: { id: string; name: string; waiting_min: number }[];
}

interface ContainmentMetrics {
  days: number;
  total: number;
  contained: number;
  escalated: number;
  no_reply: number;
  containment_rate: number | null;
  approvals_requested: number;
  approvals_pending: number;
  avg_handoff_min: number | null;
  median_handoff_min: number | null;
  median_decision_min: number | null;
  series: { date: string; total: number; contained: number }[];
}

interface CsatMetrics {
  days: number;
  prompted: number;
  answered: number;
  response_rate: number | null;
  avg_score: number | null;
  satisfied_pct: number | null;
  distribution: { score: number; count: number }[];
}

interface OperatorStat {
  user_id: string;
  name: string;
  conversations: number;
  replies: number;
  median_first_response_min: number | null;
  median_resolution_min: number | null;
  assigned_now: number;
}

const fmtMin = (m: number | null) =>
  m === null ? '—' : m < 60 ? `${Math.round(m)}m` : `${(m / 60).toFixed(1)}h`;

/** Daily containment-rate trend — one polyline over cohort days that had
 * traffic; days with no conversations are skipped (a 0-volume day isn't a
 * data point). */
function TrendChart({ series }: { series: { date: string; total: number; contained: number }[] }) {
  const pts = series.filter((d) => d.total > 0);
  if (pts.length < 2) return null;
  const W = 560;
  const H = 56;
  const PAD = 4;
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / (pts.length - 1);
  const y = (rate: number) => H - PAD - (rate * (H - 2 * PAD)) / 100;
  const path = pts
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y((d.contained / d.total) * 100).toFixed(1)}`)
    .join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 56, marginTop: 10, display: 'block' }}>
      <line x1={PAD} x2={W - PAD} y1={y(100)} y2={y(100)} stroke="var(--border)" strokeDasharray="3 4" strokeWidth="1" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((d, i) => (
        <circle key={d.date} cx={x(i)} cy={y((d.contained / d.total) * 100)} r="2.5" fill="var(--accent)">
          <title>{`${d.date}: ${Math.round((d.contained / d.total) * 100)}% of ${d.total} handled without a human`}</title>
        </circle>
      ))}
    </svg>
  );
}

interface CampaignStats {
  id: string;
  name: string;
  sends: number;
  sent: number;
  pending: number;
  failed: number;
  skipped: number;
  replied: number;
  converted: number;
  reply_rate: number | null;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Daily digests + handoff/escalation metrics. */
export default function Reports() {
  usePageTitle('Reports');
  const { data } = useDigests();
  // Drill-down: overall → per agent → per channel of that agent.
  const [agentId, setAgentId] = useState('');
  const [channelId, setChannelId] = useState('');
  // Range: preset days or a custom from/to window ('custom' uses the inputs).
  const [preset, setPreset] = useState('30');
  const [customFrom, setCustomFrom] = useState(daysAgo(30));
  const [customTo, setCustomTo] = useState(today());
  const { data: agents } = useAgents();
  const { data: chans } = useChannels();
  const custom = preset === 'custom' && customFrom && customTo;
  const rangeQs = custom ? `from=${customFrom}&to=${customTo}` : `days=${preset}`;
  const qs = `${rangeQs}${agentId ? `&agent_id=${agentId}` : ''}${channelId ? `&channel_id=${channelId}` : ''}`;
  // Deep-link params for topic drill-down — created_at bounds on the
  // conversations list use the same window semantics as the report.
  const drillFrom = custom ? customFrom : daysAgo(Number(preset));
  const drillTo = custom ? customTo : '';
  const drillQs = (extra: Record<string, string>) =>
    Object.entries({ from: drillFrom, to: drillTo, agent: agentId, ...extra })
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
  const metrics = useQuery({
    queryKey: ['handoff-metrics', qs],
    queryFn: () => api<HandoffMetrics>(`/api/reports/handoffs?${qs}`),
  });
  const containment = useQuery({
    queryKey: ['containment-metrics', qs],
    queryFn: () => api<ContainmentMetrics>(`/api/reports/containment?${qs}`),
  });
  const csat = useQuery({
    queryKey: ['csat-metrics', qs],
    queryFn: () => api<CsatMetrics>(`/api/reports/csat?${qs}`),
  });
  const operators = useQuery({
    queryKey: ['operator-metrics', qs],
    queryFn: () => api<{ days: number; operators: OperatorStat[] }>(`/api/reports/operators?${qs}`),
  });
  const intents = useQuery({
    queryKey: ['intent-metrics', qs],
    queryFn: () =>
      api<{ days: number; classified: number; total: number; intents: { intent: string; count: number; avg_csat: number | null }[] }>(
        `/api/reports/intents?${qs}`,
      ),
  });
  const volume = useQuery({
    queryKey: ['volume-metrics', qs],
    queryFn: () =>
      api<{ days: number; series: { date: string; conversations: number; in: number; out: number; human: number }[] }>(
        `/api/reports/volume?${qs}`,
      ),
  });
  const timeline = useQuery({
    queryKey: ['timeline-metrics', qs],
    queryFn: () =>
      api<{
        days: number;
        opened: number;
        resolved: number;
        resolution_rate: number | null;
        ai_resolved: number;
        human_resolved: number;
        deflection_rate: number | null;
        median_frt_min: number | null;
        median_resolution_min: number | null;
        series: {
          date: string;
          opened: number;
          frt_min: number | null;
          resolutions: number;
          resolution_min: number | null;
          ai_resolved: number;
          human_resolved: number;
        }[];
      }>(`/api/reports/timeline?${qs}`),
  });
  const campaignsReport = useQuery({
    queryKey: ['campaign-metrics', qs],
    queryFn: () =>
      api<{ days: number; totals: Omit<CampaignStats, 'id' | 'name' | 'reply_rate'>; campaigns: CampaignStats[] }>(
        `/api/reports/campaigns?${qs}`,
      ),
  });
  const usage = useQuery({
    queryKey: ['usage-metrics'],
    queryFn: () =>
      api<{
        plan: { key: string; name: string; included_messages: number; base_cents: number; overage_per_1k_cents: number | null };
        messages_used: number;
        messages_remaining: number;
        current: { period: string; llm_prompt_tokens: number; llm_completion_tokens: number; llm_cost_usd: number; voice_seconds: number };
        previous: { period: string; llm_prompt_tokens: number; llm_completion_tokens: number; llm_cost_usd: number; voice_seconds: number };
      }>('/api/reports/usage'),
  });
  const qc = useQueryClient();

  const generate = useMutation({
    mutationFn: () => api('/api/digests/generate', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['digests'] }),
  });

  const m = metrics.data;
  return (
    <>
      <div className="row">
        <h1 className="page-title grow">Reports</h1>
        <a className="btn" href={`/api/reports/export?kind=conversations&${rangeQs}`} download>
          Export conversations CSV
        </a>
        <a className="btn" href={`/api/reports/export?kind=campaign_sends&${rangeQs}`} download>
          Export campaign sends CSV
        </a>
        <button className="btn" onClick={() => generate.mutate()} disabled={generate.isPending}>
          {generate.isPending ? 'Generating…' : 'Generate digest now'}
        </button>
      </div>

      <div className="filters">
        <select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="custom">Custom…</option>
        </select>
        {preset === 'custom' && (
          <>
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label="From date"
            />
            <input
              type="date"
              value={customTo}
              min={customFrom}
              max={today()}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label="To date"
            />
          </>
        )}
        <select
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            // a channel from another agent would silently zero the results
            if (channelId && !chans?.channels.some((ch) => ch.id === channelId && ch.agent_id === e.target.value))
              setChannelId('');
          }}
        >
          <option value="">All agents</option>
          {agents?.agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          <option value="">All channels</option>
          {(chans?.channels ?? [])
            .filter((ch) => !agentId || ch.agent_id === agentId)
            .map((ch) => (
              <option key={ch.id} value={ch.id}>
                {channelLabel(ch.kind)}{ch.name ? ` · ${ch.name}` : ''}
              </option>
            ))}
        </select>
      </div>

      {/* Containment — share of conversations the agent handled alone */}
      {(() => {
        const k = containment.data;
        if (!k) return null;
        return (
          <div className="card">
            <div className="row">
              <strong className="grow">AI vs human — last {k.days} days</strong>
            </div>
            <div className="metric-grid" style={{ marginTop: 10 }}>
              <div className="metric">
                <div className="metric-num">
                  {k.containment_rate === null ? '—' : `${k.containment_rate}%`}
                </div>
                <div className="muted">handled without a human</div>
              </div>
              <div className="metric"><div className="metric-num">{k.total}</div><div className="muted">conversations</div></div>
              <div className="metric"><div className="metric-num">{k.contained}</div><div className="muted">agent only</div></div>
              <div className="metric"><div className="metric-num">{k.escalated}</div><div className="muted">needed a human</div></div>
              <div className="metric"><div className="metric-num">{k.approvals_requested}</div><div className="muted">approvals requested</div></div>
              <div className="metric"><div className="metric-num">{fmtMin(k.median_decision_min)}</div><div className="muted">median approval turnaround</div></div>
              <div className="metric"><div className="metric-num">{fmtMin(k.avg_handoff_min)}</div><div className="muted">avg time to handoff</div></div>
            </div>
            <TrendChart series={k.series} />
            {k.no_reply > 0 && (
              <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
                {k.no_reply} conversation{k.no_reply === 1 ? '' : 's'} got no agent reply at all —
                counted in the total, in neither column.
              </div>
            )}
          </div>
        );
      })()}

      {/* Resolution & speed — how fast things close, and who closes them */}
      {(() => {
        const t = timeline.data;
        if (!t || !t.opened) return null;
        const resDays = t.series.filter((d) => d.resolutions > 0);
        const maxRes = Math.max(...resDays.map((d) => d.resolutions), 1);
        return (
          <div className="card">
            <div className="row">
              <strong className="grow">Resolution &amp; speed — last {t.days} days</strong>
            </div>
            <div className="metric-grid" style={{ marginTop: 10 }}>
              <div className="metric">
                <div className="metric-num">
                  {t.deflection_rate === null ? '—' : `${t.deflection_rate}%`}
                </div>
                <div className="muted">resolved with no human touch</div>
              </div>
              <div className="metric"><div className="metric-num">{fmtMin(t.median_frt_min)}</div><div className="muted">median first response</div></div>
              <div className="metric"><div className="metric-num">{fmtMin(t.median_resolution_min)}</div><div className="muted">median time to resolve</div></div>
              <div className="metric"><div className="metric-num">{t.resolved}</div><div className="muted">resolved ({t.resolution_rate ?? '—'}% of opened)</div></div>
              <div className="metric"><div className="metric-num">{t.ai_resolved}</div><div className="muted">closed by agent alone</div></div>
              <div className="metric"><div className="metric-num">{t.human_resolved}</div><div className="muted">closed after human touch</div></div>
            </div>
            {resDays.length >= 2 && (
              <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 56, marginTop: 12 }}>
                {resDays.map((d) => (
                  <div key={d.date} style={{ flex: 1, minWidth: 2, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 1 }}
                    title={`${d.date}: ${d.resolutions} resolved — ${d.ai_resolved} agent-only, ${d.human_resolved} human-assisted${d.frt_min !== null ? ` · FRT ${fmtMin(d.frt_min)}` : ''}`}>
                    <div style={{
                      height: Math.max((d.ai_resolved / maxRes) * 52, d.ai_resolved ? 2 : 0),
                      background: 'var(--accent)', borderRadius: '2px 2px 0 0',
                    }} />
                    <div style={{
                      height: Math.max((d.human_resolved / maxRes) * 52, d.human_resolved ? 2 : 0),
                      background: 'var(--warn, #d97706)', borderRadius: '2px 2px 0 0',
                    }} />
                  </div>
                ))}
              </div>
            )}
            {resDays.length >= 2 && (
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                daily resolutions — <span style={{ color: 'var(--accent)' }}>agent alone</span> /{' '}
                <span style={{ color: 'var(--warn, #d97706)' }}>human-assisted</span>
              </div>
            )}
          </div>
        );
      })()}

      {/* Volume — daily conversations + message traffic */}
      {(() => {
        const v = volume.data;
        if (!v || v.series.length < 2) return null;
        const maxConv = Math.max(...v.series.map((d) => d.conversations), 1);
        const totals = v.series.reduce(
          (t, d) => ({ in: t.in + d.in, out: t.out + d.out, human: t.human + d.human }),
          { in: 0, out: 0, human: 0 },
        );
        return (
          <div className="card">
            <div className="row">
              <strong className="grow">Volume — last {v.days} days</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {totals.in} in · {totals.out} agent out · {totals.human} human
              </span>
            </div>
            <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 64, marginTop: 12 }}>
              {v.series.map((d) => (
                <div key={d.date} style={{ flex: 1, minWidth: 2 }}
                  title={`${d.date}: ${d.conversations} conversations · ${d.in} in / ${d.out} out / ${d.human} human`}>
                  <div style={{
                    height: Math.max((d.conversations / maxConv) * 60, d.conversations ? 2 : 0),
                    background: 'var(--accent)', borderRadius: 2,
                  }} />
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Usage — this billing period against the plan */}
      {(() => {
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
      })()}

      {/* CSAT — post-resolution customer ratings */}
      {(() => {
        const s = csat.data;
        if (!s) return null;
        if (s.prompted === 0)
          return (
            <div className="card">
              <div className="row">
                <strong className="grow">Customer satisfaction — last {s.days} days</strong>
              </div>
              <div className="muted" style={{ marginTop: 8 }}>
                No rating prompts sent in this range. Customers are asked to
                rate 1–5 when a conversation is archived — and ratings follow
                the workspace the conversation belongs to.
              </div>
            </div>
          );
        const max = Math.max(...s.distribution.map((d) => d.count), 1);
        return (
          <div className="card">
            <div className="row">
              <strong className="grow">Customer satisfaction — last {s.days} days</strong>
            </div>
            <div className="metric-grid" style={{ marginTop: 10 }}>
              <div className="metric">
                <div className="metric-num">{s.avg_score === null ? '—' : s.avg_score.toFixed(1)}</div>
                <div className="muted">avg rating (1–5)</div>
              </div>
              <div className="metric">
                <div className="metric-num">{s.satisfied_pct === null ? '—' : `${s.satisfied_pct}%`}</div>
                <div className="muted">rated 4–5</div>
              </div>
              <div className="metric"><div className="metric-num">{s.answered}</div><div className="muted">ratings</div></div>
              <div className="metric">
                <div className="metric-num">{s.response_rate === null ? '—' : `${s.response_rate}%`}</div>
                <div className="muted">answered the prompt</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 44, marginTop: 12 }}>
              {s.distribution.map((d) => (
                <div key={d.score} style={{ flex: 1, textAlign: 'center' }}>
                  <div
                    style={{
                      height: Math.max((d.count / max) * 36, d.count ? 3 : 0),
                      background: 'var(--accent)',
                      borderRadius: 3,
                      opacity: 0.5 + 0.5 * (d.score / 5),
                    }}
                    title={`${d.count} rated ${d.score}`}
                  />
                  <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{d.score}</div>
                </div>
              ))}
            </div>
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              Customers are asked to rate 1–5 when a conversation is archived.
            </div>
          </div>
        );
      })()}

      {/* Topics — classified intent volume + satisfaction per topic */}
      {(() => {
        const t = intents.data;
        if (!t || !t.classified) return null;
        const top = t.intents.filter((i) => i.intent !== 'unclassified').slice(0, 12);
        const max = Math.max(...top.map((i) => i.count), 1);
        return (
          <div className="card">
            <div className="row">
              <strong className="grow">Topics — last {t.days} days</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {t.classified} of {t.total} classified
              </span>
            </div>
            {top.map((i) => (
              <Link
                key={i.intent}
                to={`/conversations?${drillQs({ intent: i.intent })}`}
                className="row"
                style={{ marginTop: 8, gap: 10, textDecoration: 'none', color: 'inherit' }}
              >
                <span style={{ width: 120, fontSize: 13 }}>{i.intent}</span>
                <div style={{ flex: 1, background: 'var(--panel-2)', borderRadius: 3, height: 10 }}>
                  <div
                    style={{
                      width: `${(i.count / max) * 100}%`,
                      height: '100%',
                      background: 'var(--accent)',
                      borderRadius: 3,
                    }}
                  />
                </div>
                <span className="muted" style={{ width: 40, textAlign: 'right', fontSize: 12 }}>
                  {i.count}
                </span>
                <span className="muted" style={{ width: 56, textAlign: 'right', fontSize: 12 }}>
                  {i.avg_csat !== null ? `${i.avg_csat.toFixed(1)}★` : ''}
                </span>
              </Link>
            ))}
          </div>
        );
      })()}

      {/* Campaigns — outbound sends, replies and conversions in the window */}
      {(() => {
        const c = campaignsReport.data;
        if (!c || !c.campaigns.length) return null;
        const t = c.totals;
        return (
          <div className="card">
            <div className="row">
              <strong className="grow">Campaigns — last {c.days} days</strong>
              <Link to="/campaigns" className="muted" style={{ fontSize: 12 }}>Manage →</Link>
            </div>
            <div className="metric-grid" style={{ marginTop: 10 }}>
              <div className="metric"><div className="metric-num">{t.sent}</div><div className="muted">sent</div></div>
              <div className="metric"><div className="metric-num">{t.replied}</div><div className="muted">replied</div></div>
              <div className="metric"><div className="metric-num">{t.converted}</div><div className="muted">converted</div></div>
              <div className="metric"><div className="metric-num">{t.pending}</div><div className="muted">queued</div></div>
              <div className="metric"><div className="metric-num">{t.failed}</div><div className="muted">failed</div></div>
              <div className="metric"><div className="metric-num">{t.skipped}</div><div className="muted">skipped</div></div>
            </div>
            <table className="docs-table" style={{ marginTop: 10 }}>
              <thead>
                <tr className="muted">
                  <th style={{ textAlign: 'left' }}>Campaign</th>
                  <th>Sent</th>
                  <th>Replied</th>
                  <th>Reply rate</th>
                  <th>Converted</th>
                  <th>Failed</th>
                  <th>Skipped</th>
                </tr>
              </thead>
              <tbody>
                {c.campaigns.map((cp) => (
                  <tr key={cp.id}>
                    <td><Link to="/campaigns">{cp.name}</Link></td>
                    <td style={{ textAlign: 'center' }}>{cp.sent}</td>
                    <td style={{ textAlign: 'center' }}>{cp.replied}</td>
                    <td style={{ textAlign: 'center' }}>{cp.reply_rate === null ? '—' : `${cp.reply_rate}%`}</td>
                    <td style={{ textAlign: 'center' }}>{cp.converted}</td>
                    <td style={{ textAlign: 'center' }}>{cp.failed}</td>
                    <td style={{ textAlign: 'center' }}>{cp.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })()}

      {/* Team — per-operator workload + responsiveness */}
      {(() => {
        const ops = operators.data?.operators ?? [];
        if (!ops.length) return null;
        return (
          <div className="card">
            <div className="row">
              <strong className="grow">Team — last {operators.data?.days ?? 30} days</strong>
            </div>
            <table className="docs-table" style={{ marginTop: 10 }}>
              <thead>
                <tr className="muted">
                  <th style={{ textAlign: 'left' }}>Teammate</th>
                  <th>Conversations</th>
                  <th>Replies</th>
                  <th>Median 1st response</th>
                  <th>Median resolution</th>
                  <th>Assigned now</th>
                </tr>
              </thead>
              <tbody>
                {ops.map((o) => (
                  <tr key={o.user_id}>
                    <td>{o.name}</td>
                    <td style={{ textAlign: 'center' }}>{o.conversations}</td>
                    <td style={{ textAlign: 'center' }}>{o.replies}</td>
                    <td style={{ textAlign: 'center' }}>{fmtMin(o.median_first_response_min)}</td>
                    <td style={{ textAlign: 'center' }}>{fmtMin(o.median_resolution_min)}</td>
                    <td style={{ textAlign: 'center' }}>{o.assigned_now}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })()}

      {/* Handoff metrics — last 30 days */}
      <div className="card">
        <div className="row">
          <strong className="grow">Handoffs — last {m?.days ?? 30} days</strong>
          {m && m.overdue > 0 && (
            <Link to="/conversations?state=overdue" className="badge needs_human">
              {m.overdue} overdue
            </Link>
          )}
        </div>
        {m ? (
          <>
            <div className="metric-grid" style={{ marginTop: 10 }}>
              <div className="metric"><div className="metric-num">{m.handoffs}</div><div className="muted">handoffs</div></div>
              <div className="metric"><div className="metric-num">{m.response_rate === null ? '—' : `${m.response_rate}%`}</div><div className="muted">answered by a human</div></div>
              <div className="metric"><div className="metric-num">{fmtMin(m.avg_first_response_min)}</div><div className="muted">avg first response</div></div>
              <div className="metric"><div className="metric-num">{fmtMin(m.median_first_response_min)}</div><div className="muted">median first response</div></div>
              <div className="metric"><div className="metric-num">{m.unresolved}</div><div className="muted">still unclaimed</div></div>
            </div>
            {m.stale.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="muted" style={{ marginBottom: 6 }}>Longest waiting:</div>
                {m.stale.map((s) => (
                  <div key={s.id} className="row muted" style={{ marginTop: 4 }}>
                    <Link to={`/conversations/${s.id}`} className="grow">{s.name}</Link>
                    <span>{fmtMin(s.waiting_min)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="muted" style={{ marginTop: 8 }}>Loading…</div>
        )}
      </div>

      <div className="muted" style={{ margin: '12px 0' }}>
        A digest is emitted daily and pushed to Slack + notifications.
      </div>

      {data && data.digests.length === 0 && (
        <Empty>No digests yet. Generate one or wait for the daily run.</Empty>
      )}
      {data?.digests.map((d) => (
        <div key={d.id} className="card">
          <strong>{new Date(d.period_start).toLocaleDateString()}</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {d.stats.conversations} new conversations · {d.stats.messages_in} in /{' '}
            {d.stats.messages_out} out / {d.stats.messages_human} human · {d.stats.alerts} alerts ·{' '}
            {d.stats.takeovers} takeovers
          </div>
        </div>
      ))}
    </>
  );
}
