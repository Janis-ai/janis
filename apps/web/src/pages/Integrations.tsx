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

const KINDS = [
  { value: 'messenger', label: 'Facebook Messenger', needs: 'page_id' },
  { value: 'instagram', label: 'Instagram DM', needs: 'page_id' },
  { value: 'whatsapp', label: 'WhatsApp Business', needs: 'phone_number_id' },
] as const;

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
  const connectId = params.get('meta_connect') ?? '';
  const metaError = params.get('meta_error') ?? '';
  const metaStatus = useQuery({
    queryKey: ['meta-status'],
    queryFn: () => api<{ configured: boolean }>('/api/meta/status'),
    staleTime: Infinity,
  });
  const pending = useQuery({
    queryKey: ['meta-pending', connectId],
    queryFn: () => api<PendingAssets>(`/api/meta/pending?id=${connectId}`),
    enabled: Boolean(connectId),
    retry: false,
  });
  const [linkAgent, setLinkAgent] = useState('');
  const link = useMutation({
    mutationFn: (body: { kind: string; page_id?: string; phone_number_id?: string }) =>
      api('/api/meta/link', {
        method: 'POST',
        body: JSON.stringify({ connect_id: connectId, agent_id: linkAgent, ...body }),
      }),
    onSuccess: () => {
      setParams({});
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (e) => setError(e.message),
  });
  const [form, setForm] = useState({
    kind: 'messenger' as (typeof KINDS)[number]['value'],
    name: '',
    agent_id: '',
    page_id: '',
    phone_number_id: '',
    access_token: '',
  });
  const [error, setError] = useState('');
  const apiOrigin = window.location.hostname === 'localhost' ? 'http://localhost:8787' : '';

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

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['channels'] }),
  });

  const needs = KINDS.find((k) => k.value === form.kind)?.needs;

  return (
    <>
      <h1 className="page-title">Integrations</h1>
      <div className="muted" style={{ marginBottom: 16 }}>
        Hosted channels: Janis owns the Meta webhook and relays messages to the agent — during a
        human takeover the agent is cut off at the pipe.
      </div>

      {data?.channels.map((ch) => (
        <div key={ch.id} className="card">
          <div className="row">
            <strong className="grow">{ch.name}</strong>
            <span className="badge active">{ch.kind}</span>
            <button className="btn danger" onClick={() => remove.mutate(ch.id)}>Delete</button>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            <div>Agent: {ch.agent_name}</div>
            {ch.meta.page_id && <div>Page id: {ch.meta.page_id}</div>}
            {ch.meta.phone_number_id && <div>Phone number id: {ch.meta.phone_number_id}</div>}
            <div className="mono">
              Webhook: {apiOrigin || '{API_ORIGIN}'}/channels/meta/webhook
            </div>
            <div className="mono">Verify token: {ch.meta.verify_token}</div>
          </div>
        </div>
      ))}
      {data && data.channels.length === 0 && (
        <Empty>No channels yet — connect Messenger, Instagram, or WhatsApp below.</Empty>
      )}

      {metaStatus.data?.configured && (
        <div className="card">
          <div className="row">
            <strong className="grow">Connect with Meta</strong>
            <a className="btn primary" href="/api/meta/connect">Connect Facebook</a>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            Authorize once — Janis lists your Pages, linked Instagram accounts, and WhatsApp
            numbers, then subscribes the webhook for you.
          </div>
        </div>
      )}

      {metaError && <div className="error">Meta connect failed: {metaError}</div>}

      {connectId && (
        <div className="card">
          <strong>Pick what to connect</strong>
          {pending.isLoading && <div className="muted" style={{ marginTop: 8 }}>Loading discovered assets…</div>}
          {pending.isError && <div className="error">Connect session expired — start again.</div>}
          {pending.data && (
            <>
              <div className="row" style={{ marginTop: 10 }}>
                <label>Agent:</label>
                <select value={linkAgent} onChange={(e) => setLinkAgent(e.target.value)} className="grow">
                  <option value="">Which agent answers?…</option>
                  {agents?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              {pending.data.pages.map((pg) => (
                <div key={pg.id} className="row" style={{ marginTop: 10 }}>
                  <span className="grow">{pg.name} <span className="muted">(page {pg.id})</span></span>
                  <button className="btn" disabled={!linkAgent || link.isPending}
                    onClick={() => link.mutate({ kind: 'messenger', page_id: pg.id })}>
                    Messenger
                  </button>
                  {pg.instagram && (
                    <button className="btn" disabled={!linkAgent || link.isPending}
                      onClick={() => link.mutate({ kind: 'instagram', page_id: pg.id })}>
                      Instagram {pg.instagram.username ? `@${pg.instagram.username}` : ''}
                    </button>
                  )}
                </div>
              ))}
              {pending.data.whatsapp.flatMap((w) =>
                w.phone_numbers.map((n) => (
                  <div key={n.id} className="row" style={{ marginTop: 10 }}>
                    <span className="grow">{n.display_phone_number ?? n.id} <span className="muted">(WhatsApp)</span></span>
                    <button className="btn" disabled={!linkAgent || link.isPending}
                      onClick={() => link.mutate({ kind: 'whatsapp', phone_number_id: n.id })}>
                      WhatsApp
                    </button>
                  </div>
                )),
              )}
              {pending.data.pages.length === 0 && pending.data.whatsapp.length === 0 && (
                <Empty>No Pages or WhatsApp accounts found on that Meta login.</Empty>
              )}
            </>
          )}
        </div>
      )}

      <div className="card">
        <strong>Connect a channel</strong>
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, maxWidth: 520 }}
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
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
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
          {needs === 'page_id' && (
            <input
              placeholder="Facebook Page ID (or IG-linked page id)"
              value={form.page_id}
              onChange={(e) => setForm({ ...form, page_id: e.target.value })}
              required
            />
          )}
          {needs === 'phone_number_id' && (
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
            <button className="btn primary" disabled={create.isPending}>Add channel</button>
          </div>
        </form>
        {error && <div className="error">{error}</div>}
        <div className="muted" style={{ marginTop: 10 }}>
          In your Meta app, set the callback URL to the webhook above and paste the verify token.
          Subscribe to <span className="mono">messages</span> (Messenger/IG) or the WhatsApp
          messages field. Set META_APP_SECRET on the API for signature verification.
        </div>
      </div>
    </>
  );
}
