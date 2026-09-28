import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAgents, useChannels, useDigests } from '../api/hooks';
import { Empty, channelLabel } from '../components/bits';

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

/** Daily digests + handoff/escalation metrics. */
export default function Reports() {
  const { data } = useDigests();
  // Drill-down: overall → per agent → per channel of that agent.
  const [agentId, setAgentId] = useState('');
  const [channelId, setChannelId] = useState('');
  const { data: agents } = useAgents();
  const { data: chans } = useChannels();
  const qs = `days=30${agentId ? `&agent_id=${agentId}` : ''}${channelId ? `&channel_id=${channelId}` : ''}`;
  const metrics = useQuery({
    queryKey: ['handoff-metrics', agentId, channelId],
    queryFn: () => api<HandoffMetrics>(`/api/reports/handoffs?${qs}`),
  });
  const containment = useQuery({
    queryKey: ['containment-metrics', agentId, channelId],
    queryFn: () => api<ContainmentMetrics>(`/api/reports/containment?${qs}`),
  });
  const csat = useQuery({
    queryKey: ['csat-metrics', agentId, channelId],
    queryFn: () => api<CsatMetrics>(`/api/reports/csat?${qs}`),
  });
  const operators = useQuery({
    queryKey: ['operator-metrics', agentId, channelId],
    queryFn: () => api<{ days: number; operators: OperatorStat[] }>(`/api/reports/operators?${qs}`),
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
        <button className="btn" onClick={() => generate.mutate()} disabled={generate.isPending}>
          {generate.isPending ? 'Generating…' : 'Generate digest now'}
        </button>
      </div>

      <div className="filters">
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
              <strong className="grow">Containment — last {k.days} days</strong>
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

      {/* CSAT — post-resolution customer ratings */}
      {(() => {
        const s = csat.data;
        if (!s || s.prompted === 0) return null;
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
