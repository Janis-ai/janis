import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAgents, useChannels } from '../api/hooks';
import { Empty } from '../components/bits';

interface PendingAssets {
  pages: { id: string; name: string; instagram: { id: string; username?: string } | null }[];
  whatsapp: { id: string; name?: string; phone_numbers: { id: string; display_phone_number?: string }[] }[];
}

const KIND_LABEL: Record<string, string> = {
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
};

/**
 * Hosted channel integrations — Messenger / Instagram / WhatsApp.
 * Janis owns the Meta webhook; inbound messages reach the agent only while
 * it owns the conversation (enforced gating during human takeover).
 */
export default function Integrations() {
  const { data } = useChannels();
  const { data: agents } = useAgents();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const metaError = params.get('meta_error') ?? '';
  const [showManual, setShowManual] = useState(false);
  const [linkAgent, setLinkAgent] = useState('');
  const [error, setError] = useState('');
  const apiOrigin = window.location.hostname === 'localhost' ? 'http://localhost:8787' : '';

  const metaStatus = useQuery({
    queryKey: ['meta-status'],
    queryFn: () => api<{ configured: boolean }>('/api/meta/status'),
    staleTime: Infinity,
  });
  const session = useQuery({
    queryKey: ['meta-session'],
    queryFn: () =>
      api<{ connected: boolean; connect_id?: string; expired?: boolean }>('/api/meta/session'),
    staleTime: 60_000,
  });
  const connectId =
    params.get('meta_connect') ?? (session.data?.connected ? session.data.connect_id ?? '' : '');
  const disconnect = useMutation({
    mutationFn: () => api('/api/meta/session', { method: 'DELETE' }),
    onSuccess: () => {
      setParams({});
      void qc.invalidateQueries({ queryKey: ['meta-session'] });
    },
  });
  const pending = useQuery({
    queryKey: ['meta-pending', connectId],
    queryFn: () => api<PendingAssets>(`/api/meta/pending?id=${connectId}`),
    enabled: Boolean(connectId),
    retry: false,
  });

  const link = useMutation({
    mutationFn: (body: { kind: string; page_id?: string; phone_number_id?: string }) =>
      api('/api/meta/link', {
        method: 'POST',
        body: JSON.stringify({ connect_id: connectId, agent_id: linkAgent, ...body }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (e) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['channels'] }),
    onError: (e) => setError(e.message),
  });

  const [form, setForm] = useState({
    kind: 'messenger' as 'messenger' | 'instagram' | 'whatsapp',
    name: '',
    agent_id: '',
    page_id: '',
    phone_number_id: '',
    access_token: '',
  });
  const create = useMutation({
    mutationFn: () =>
      api('/api/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: form.kind,
          name: form.name,
          agent_id: form.agent_id,
          page_id: form.page_id || undefined,
          phone_number_id: form.phone_number_id || undefined,
          access_token: form.access_token,
        }),
      }),
    onSuccess: () => {
      setForm({ ...form, name: '', page_id: '', phone_number_id: '', access_token: '' });
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (e) => setError(e.message),
  });

  const hasAssets =
    pending.data && (pending.data.pages.length > 0 || pending.data.whatsapp.length > 0);
  // Map a discovered asset id (page / ig account / phone_number_id) to its channel.
  const linkedChannels = new Map(
    (data?.channels ?? []).flatMap((ch) =>
      [ch.meta.page_id, ch.meta.phone_number_id]
        .filter((v): v is string => Boolean(v))
        .map((v) => [v, ch.id] as const),
    ),
  );

  return (
    <>
      <h1 className="page-title">Integrations</h1>
      <div className="muted" style={{ marginBottom: 16 }}>
        Connect your Facebook, Instagram, or WhatsApp business — Janis hosts the webhook and
        relays messages to your agent. During a human takeover the agent is cut off at the pipe.
      </div>

      {metaError && <div className="error" style={{ marginBottom: 12 }}>Meta connect failed: {metaError}</div>}
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Step 1: OAuth connect (primary path) or pending asset picker */}
      {connectId ? (
        <div className="card connect-card">
          <div className="row">
            <strong className="grow">Meta connected — pick what to link</strong>
            <a href="/api/meta/connect" onClick={() => setParams({})}>Switch account</a>
            <button className="btn" onClick={() => disconnect.mutate()}>Disconnect</button>
          </div>
          {pending.isLoading && <div className="muted" style={{ marginTop: 8 }}>Looking up your Meta accounts…</div>}
          {pending.isError && (
            <div className="error">
              Couldn't load your Meta assets.{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setParams({});
                  void qc.invalidateQueries({ queryKey: ['meta-session'] });
                }}
              >
                Retry
              </a>
              {' · '}
              <a href="/api/meta/connect">Reconnect Facebook</a>
            </div>
          )}
          {pending.data && (
            <>
              <div className="row" style={{ marginTop: 12 }}>
                <label style={{ margin: 0 }}>Answered by</label>
                <select value={linkAgent} onChange={(e) => setLinkAgent(e.target.value)} className="grow">
                  <option value="">choose an agent…</option>
                  {agents?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="asset-list">
                {pending.data.pages.map((pg) => (
                  <div key={pg.id} className="asset-row">
                    <div className="grow">
                      <strong>{pg.name}</strong>
                      <div className="muted">Facebook Page</div>
                    </div>
                    {linkedChannels.has(pg.id) ? (
                      <button className="btn danger" disabled={remove.isPending}
                        onClick={() => remove.mutate(linkedChannels.get(pg.id)!)}>
                        Remove Messenger
                      </button>
                    ) : (
                      <button className="btn" disabled={!linkAgent || link.isPending}
                        onClick={() => link.mutate({ kind: 'messenger', page_id: pg.id })}>
                        Connect Messenger
                      </button>
                    )}
                    {pg.instagram && (
                      linkedChannels.has(pg.instagram.id) ? (
                        <button className="btn danger" disabled={remove.isPending}
                          onClick={() => remove.mutate(linkedChannels.get(pg.instagram!.id)!)}>
                          Remove Instagram
                        </button>
                      ) : (
                        <button className="btn" disabled={!linkAgent || link.isPending}
                          onClick={() => link.mutate({ kind: 'instagram', page_id: pg.id })}>
                          Connect Instagram{pg.instagram.username ? ` @${pg.instagram.username}` : ''}
                        </button>
                      )
                    )}
                  </div>
                ))}
                {pending.data.whatsapp.flatMap((w) =>
                  w.phone_numbers.map((n) => (
                    <div key={n.id} className="asset-row">
                      <div className="grow">
                        <strong>{n.display_phone_number ?? n.id}</strong>
                        <div className="muted">WhatsApp Business{w.name ? ` · ${w.name}` : ''}</div>
                      </div>
                      {linkedChannels.has(n.id) ? (
                        <button className="btn danger" disabled={remove.isPending}
                          onClick={() => remove.mutate(linkedChannels.get(n.id)!)}>
                          Remove WhatsApp
                        </button>
                      ) : (
                        <button className="btn" disabled={!linkAgent || link.isPending}
                          onClick={() => link.mutate({ kind: 'whatsapp', phone_number_id: n.id })}>
                          Connect WhatsApp
                        </button>
                      )}
                    </div>
                  )),
                )}
              </div>
              {!hasAssets && <Empty>No Pages or WhatsApp numbers found on that Meta login.</Empty>}
            </>
          )}
        </div>
      ) : (
        <div className="card connect-card">
          {metaStatus.data?.configured ? (
            <div className="row">
              <div className="grow">
                <strong>Connect with Meta</strong>
                {session.data?.expired && (
                  <div className="error" style={{ marginTop: 4 }}>
                    Your Facebook session expired — reconnect to manage channels.
                  </div>
                )}
                <div className="muted" style={{ marginTop: 4 }}>
                  Sign in once — Janis finds your Pages, Instagram accounts, and WhatsApp numbers
                  and sets up the webhook for you.
                </div>
              </div>
              <a className="btn primary" href="/api/meta/connect">Connect Facebook</a>
            </div>
          ) : (
            <div className="muted">
              One-click connect isn't configured — set <span className="mono">META_APP_ID</span> and{' '}
              <span className="mono">META_APP_SECRET</span> on the API to enable it.
            </div>
          )}
        </div>
      )}

      {/* Connected channels */}
      {data && data.channels.length > 0 && (
        <h2 className="section-title">Connected channels</h2>
      )}
      {data?.channels.map((ch) => (
        <div key={ch.id} className="card channel-card">
          <div className="row">
            <strong className="grow">{ch.name}</strong>
            <span className="badge active">{KIND_LABEL[ch.kind] ?? ch.kind}</span>
            <button className="btn danger" onClick={() => remove.mutate(ch.id)}>Remove</button>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            Answered by <strong>{ch.agent_name}</strong>
            {ch.meta.page_id && <> · page {ch.meta.page_id}</>}
            {ch.meta.phone_number_id && <> · {ch.meta.phone_number_id}</>}
          </div>
          {ch.meta.chat_url && (
            <div style={{ marginTop: 6 }}>
              <a href={ch.meta.chat_url} target="_blank" rel="noreferrer">
                Open chat as a customer ↗
              </a>
            </div>
          )}
          {ch.meta.via !== 'oauth' && (
          <details className="webhook-details">
            <summary>Webhook details</summary>
            <div className="mono" style={{ marginTop: 6 }}>
              <div>URL: {apiOrigin || '{API_ORIGIN}'}/channels/meta/webhook</div>
              <div>Verify token: {ch.meta.verify_token}</div>
            </div>
          </details>
          )}
        </div>
      ))}
      {data && data.channels.length === 0 && !connectId && (
        <Empty>No channels connected yet.</Empty>
      )}

      {/* Manual entry — advanced */}
      <div className="card">
        <details open={showManual} onToggle={(e) => setShowManual((e.target as HTMLDetailsElement).open)}>
          <summary><strong>Advanced: connect with credentials</strong></summary>
          <form
            style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, maxWidth: 520 }}
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="row">
              <select
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}
              >
                <option value="messenger">Facebook Messenger</option>
                <option value="instagram">Instagram DM</option>
                <option value="whatsapp">WhatsApp Business</option>
              </select>
              <select
                className="grow"
                value={form.agent_id}
                onChange={(e) => setForm({ ...form, agent_id: e.target.value })}
                required
              >
                <option value="">Which agent answers?…</option>
                {agents?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <input
              placeholder="Channel name (e.g. Acme Facebook Page)"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
            {form.kind !== 'whatsapp' && (
              <input
                placeholder="Facebook Page ID"
                value={form.page_id}
                onChange={(e) => setForm({ ...form, page_id: e.target.value })}
                required
              />
            )}
            {form.kind === 'whatsapp' && (
              <input
                placeholder="WhatsApp phone_number_id"
                value={form.phone_number_id}
                onChange={(e) => setForm({ ...form, phone_number_id: e.target.value })}
                required
              />
            )}
            <input
              placeholder="Access token (page token / system user token)"
              value={form.access_token}
              onChange={(e) => setForm({ ...form, access_token: e.target.value })}
              required
            />
            <div>
              <button className="btn" disabled={create.isPending}>Add channel</button>
            </div>
          </form>
          <div className="muted" style={{ marginTop: 10 }}>
            Then register <span className="mono">{apiOrigin || '{API_ORIGIN}'}/channels/meta/webhook</span>{' '}
            in your Meta app with the channel's verify token, and subscribe to <span className="mono">messages</span>.
          </div>
        </details>
      </div>
    </>
  );
}
