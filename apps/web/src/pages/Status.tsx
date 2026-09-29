import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

type StatusResp = {
  ok: boolean;
  checks: Record<string, 'ok' | 'degraded'>;
  ts: string;
};

/** Public status surface — /status answers "is it us or them" for customers
 *  without a login. Reads the same probe monitors hit. */
export function Status() {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ['status'],
    queryFn: () => api<StatusResp>('/status'),
    refetchInterval: 30_000,
    retry: false,
  });

  const LABELS: Record<string, string> = {
    db: 'Database',
    background: 'Background workers',
  };

  return (
    <div className="login-wrap">
      <div className="card" style={{ maxWidth: 480, width: '100%' }}>
        <h1 style={{ fontSize: 20 }}>Janis status</h1>
        {isLoading && <div className="muted">Checking…</div>}
        {isError && (
          <div className="badge needs_human" style={{ marginTop: 8 }}>
            Unreachable — the API is down or unreachable
          </div>
        )}
        {data && (
          <>
            <div className={`badge ${data.ok ? 'active' : 'needs_human'}`} style={{ marginTop: 8 }}>
              {data.ok ? 'All systems operational' : 'Degraded'}
            </div>
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {Object.entries(data.checks).map(([k, v]) => (
                <div key={k} className="row">
                  <span className="grow">{LABELS[k] ?? k}</span>
                  <span className={`badge ${v === 'ok' ? 'active' : 'needs_human'}`}>{v}</span>
                </div>
              ))}
            </div>
            <div className="muted" style={{ marginTop: 14, fontSize: 12 }}>
              Checked {new Date(dataUpdatedAt).toLocaleTimeString()} · refreshes every 30s
            </div>
          </>
        )}
      </div>
    </div>
  );
}
