// Errors — self-captured client/API error bundles. Each report is a packet
// an agent can triage from: message + stack, route, console tail, failed
// requests, settings, DOM snapshot and a screenshot when capture worked.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { usePageTitle } from '../lib/title';

type ReportRow = {
  id: string;
  source: string;
  message: string;
  url: string | null;
  route: string | null;
  hasScreenshot: boolean;
  createdAt: string;
};

type Report = ReportRow & {
  stack: string | null;
  payload: {
    route?: string;
    ua?: string;
    viewport?: string;
    trigger?: string;
    dom?: string;
    screenshot?: string;
    console_tail?: string[];
    failed_requests?: { url: string; status?: number; error?: string; at?: string }[];
    settings?: Record<string, unknown>;
  };
};

export default function Errors() {
  usePageTitle('Errors');
  const [openId, setOpenId] = useState('');
  const [copied, setCopied] = useState(false);
  const { data } = useQuery({
    queryKey: ['error-reports'],
    queryFn: () => api<{ reports: ReportRow[] }>('/api/error-reports'),
    refetchInterval: 30_000,
  });
  const detail = useQuery({
    queryKey: ['error-report', openId],
    enabled: !!openId,
    queryFn: () => api<{ report: Report }>(`/api/error-reports/${openId}`),
  });

  const [downloaded, setDownloaded] = useState('');
  const downloadNew = async () => {
    const res = await fetch('/api/error-reports/export', { credentials: 'include' });
    if (!res.ok) {
      setDownloaded('Export failed');
      return;
    }
    const bundle = await res.json();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `janis-errors-${new Date().toISOString().slice(0, 19)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setDownloaded(`Downloaded ${bundle.count} report(s) — the next export starts after them.`);
  };

  const copyBundle = async () => {
    if (!detail.data) return;
    await navigator.clipboard.writeText(JSON.stringify(detail.data.report, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="page-pad" style={{ maxWidth: 900 }}>
      <h1>Error reports</h1>
      <p className="muted">
        Uncaught console errors and API failures package themselves here — screenshot, DOM,
        console tail and settings included. Copy a bundle straight into a debugging agent,
        or ask Janis about recent breakage. Operator-only.
      </p>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={() => void downloadNew()}>
          Download new errors (.json)
        </button>
        <span className="muted" style={{ fontSize: 13 }}>{downloaded}</span>
      </div>
      {(data?.reports ?? []).map((r) => (
        <div key={r.id} className="card" style={{ marginTop: 12 }}>
          <div className="row">
            <div className="grow">
              <span className="chip">{r.source}</span>{' '}
              <strong style={{ fontSize: 14 }}>{r.message.slice(0, 140)}</strong>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                {new Date(r.createdAt).toLocaleString()}
                {r.route && ` · ${r.route}`}
                {r.hasScreenshot && ' · 📷'}
              </div>
            </div>
            <button className="btn ghost" onClick={() => setOpenId(openId === r.id ? '' : r.id)}>
              Details
            </button>
          </div>
          {openId === r.id && detail.data && (() => {
            const p = detail.data.report.payload ?? {};
            return (
              <div style={{ marginTop: 10 }}>
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="muted grow" style={{ fontSize: 12 }}>
                    {p.ua}
                    {p.viewport && ` · ${p.viewport}`}
                    {p.trigger && ` · via ${p.trigger}`}
                    {detail.data.report.url && ` · ${detail.data.report.url}`}
                  </span>
                  <button className="btn sm" onClick={copyBundle}>
                    {copied ? 'Copied' : 'Copy bundle'}
                  </button>
                </div>
                {p.screenshot && (
                  <img
                    src={p.screenshot}
                    alt="Screenshot at time of error"
                    style={{ maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8 }}
                  />
                )}
                {detail.data.report.stack && (
                  <pre className="muted" style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginBottom: 8 }}>
                    {detail.data.report.stack}
                  </pre>
                )}
                {!!p.failed_requests?.length && (
                  <div style={{ fontSize: 13, marginBottom: 8 }}>
                    <strong>Failed requests</strong>
                    {p.failed_requests.map((f, i) => (
                      <div key={i} className="muted">
                        {f.url} — {f.status ?? f.error ?? 'network'}
                      </div>
                    ))}
                  </div>
                )}
                {!!p.console_tail?.length && (
                  <div style={{ marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>Console tail</strong>
                    <pre className="muted" style={{ fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>
                      {p.console_tail.join('\n')}
                    </pre>
                  </div>
                )}
                {!!p.settings && !!Object.keys(p.settings).length && (
                  <div style={{ marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>Client settings</strong>
                    <pre className="muted" style={{ fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
                      {JSON.stringify(p.settings, null, 2)}
                    </pre>
                  </div>
                )}
                {p.dom && (
                  <details>
                    <summary style={{ fontSize: 13, cursor: 'pointer' }}>DOM snapshot ({Math.round(p.dom.length / 1024)}k chars)</summary>
                    <pre className="muted" style={{ fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>
                      {p.dom}
                    </pre>
                  </details>
                )}
              </div>
            );
          })()}
        </div>
      ))}
      {!!data && !data.reports.length && (
        <p className="muted" style={{ marginTop: 14 }}>No error reports — nothing has tripped the reporter.</p>
      )}
    </div>
  );
}
