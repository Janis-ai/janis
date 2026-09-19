import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useDigests } from '../api/hooks';
import { Empty } from '../components/bits';

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

const fmtMin = (m: number | null) =>
  m === null ? '—' : m < 60 ? `${Math.round(m)}m` : `${(m / 60).toFixed(1)}h`;

/** Daily digests + handoff/escalation metrics. */
export default function Reports() {
  const { data } = useDigests();
  const metrics = useQuery({
    queryKey: ['handoff-metrics'],
    queryFn: () => api<HandoffMetrics>('/api/reports/handoffs?days=30'),
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

      {/* Handoff metrics — last 30 days */}
      <div className="card">
        <div className="row">
          <strong className="grow">Handoffs — last {m?.days ?? 30} days</strong>
          {m && m.overdue > 0 && <span className="badge needs_human">{m.overdue} overdue</span>}
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
