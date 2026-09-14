import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAgents } from '../api/hooks';
import { Empty } from '../components/bits';

const KINDS = [
  { value: 'messenger', label: 'Facebook Messenger', needs: 'page_id' },
  { value: 'instagram', label: 'Instagram DM', needs: 'page_id' },
  { value: 'whatsapp', label: 'WhatsApp Business', needs: 'phone_number_id' },
] as const;

function useChannels() {
  return useQuery({
    queryKey: ['channels'],
    queryFn: () => api<{ channels: import('@janis/shared').Channel[] }>('/api/channels'),
  });
}

/**
 * Hosted channel integrations — Messenger / Instagram / WhatsApp.
 * Janis owns the Meta webhook; inbound messages reach the agent only while
 * it owns the conversation (enforced gating during human takeover).
 */
export default function Integrations() {
  const { data } = useChannels();
  const { data: agents } = useAgents();
  const qc = useQueryClient();
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
