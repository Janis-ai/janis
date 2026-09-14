import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useDigests } from '../api/hooks';
import { Empty } from '../components/bits';

/** Daily digests: traffic, alerts, and takeover volume per day. */
export default function Reports() {
  const { data } = useDigests();
  const qc = useQueryClient();

  const generate = useMutation({
    mutationFn: () => api('/api/digests/generate', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['digests'] }),
  });

  return (
    <>
      <div className="row">
        <h1 className="page-title grow">Reports</h1>
        <button className="btn" onClick={() => generate.mutate()} disabled={generate.isPending}>
          {generate.isPending ? 'Generating…' : 'Generate digest now'}
        </button>
      </div>
      <div className="muted" style={{ marginBottom: 12 }}>
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
