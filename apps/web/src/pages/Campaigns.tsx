// Campaigns — proactive outbound: pick a channel + audience filter, send or schedule.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useChannels } from '../api/hooks';

const SENDABLE = ['sms', 'whatsapp', 'email', 'gmail', 'outlook'];

type Stats = { total: number; sent: number; failed: number; pending: number; skipped: number };
type CampaignRow = {
  id: string;
  name: string;
  status: string;
  channel_name: string;
  channel_kind: string;
  scheduled_at: string | null;
  stats: Stats;
};
type SendRow = { id: string; recipient: string; status: string; error: string | null; sent_at: string | null };

export default function Campaigns() {
  const qc = useQueryClient();
  const { data: chans } = useChannels();
  const channels = (chans?.channels ?? []).filter((c) => SENDABLE.includes(c.kind));
  const { data } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api<{ campaigns: CampaignRow[] }>('/api/campaigns'),
    refetchInterval: 10_000,
  });
  const [openId, setOpenId] = useState('');
  const detail = useQuery({
    queryKey: ['campaign', openId],
    enabled: !!openId,
    queryFn: () => api<{ stats: Stats; sends: SendRow[] }>(`/api/campaigns/${openId}`),
    refetchInterval: 10_000,
  });

  const [err, setErr] = useState('');
  const act = (id: string, action: 'send' | 'delete') =>
    action === 'send'
      ? api(`/api/campaigns/${id}/send`, { method: 'POST' })
      : api(`/api/campaigns/${id}`, { method: 'DELETE' });
  const mutate = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'send' | 'delete' }) => act(id, action),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['campaigns'] }),
    onError: (e) => setErr(e.message),
  });

  const [form, setForm] = useState({
    name: '', channel_id: '', subject: '', text: '', template: '', q: '', scheduled_at: '',
  });
  const preview = useQuery({
    queryKey: ['campaign-preview', form.channel_id, form.q],
    enabled: !!form.channel_id,
    queryFn: () =>
      api<{ total: number; opted_out: number }>('/api/campaigns/preview', {
        method: 'POST',
        body: JSON.stringify({ channel_id: form.channel_id, segment: form.q ? { q: form.q } : {} }),
      }),
  });
  const create = useMutation({
    mutationFn: () =>
      api(`/api/campaigns`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          channel_id: form.channel_id,
          text: form.text,
          subject: form.subject || undefined,
          whatsapp_template: form.template ? { name: form.template } : undefined,
          segment: form.q ? { q: form.q } : {},
          scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).toISOString() : undefined,
        }),
      }),
    onSuccess: () => {
      setForm({ name: '', channel_id: '', subject: '', text: '', template: '', q: '', scheduled_at: '' });
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onError: (e) => setErr(e.message),
  });

  const kind = channels.find((c) => c.id === form.channel_id)?.kind;
  const isEmail = ['email', 'gmail', 'outlook'].includes(kind ?? '');

  return (
    <div className="page-pad" style={{ maxWidth: 900 }}>
      <h1>Campaigns</h1>
      <p className="muted">
        Proactive sends to contacts on a channel. SMS, email, Outlook and Gmail open new
        threads; WhatsApp requires an approved template. Opted-out contacts are skipped
        and recorded.
      </p>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card">
        <h3>New campaign</h3>
        <div className="row wrap" style={{ gap: 10, marginTop: 10 }}>
          <input className="input grow" placeholder="Name" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select className="input" value={form.channel_id}
            onChange={(e) => setForm({ ...form, channel_id: e.target.value })}>
            <option value="">Channel…</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>
            ))}
          </select>
          <input className="input" type="datetime-local" title="Schedule (blank = draft)"
            value={form.scheduled_at}
            onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })} />
        </div>
        <div className="row" style={{ gap: 10, marginTop: 10 }}>
          <input className="input grow" placeholder="Audience: name/email/phone contains… (blank = all)"
            value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} />
          {preview.data && (
            <span className="muted" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
              {preview.data.total} recipients
              {!!preview.data.opted_out && ` (${preview.data.opted_out} opted out)`}
            </span>
          )}
        </div>
        {isEmail && (
          <input className="input" style={{ marginTop: 10, width: '100%' }} placeholder="Subject"
            value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        )}
        {kind === 'whatsapp' ? (
          <input className="input" style={{ marginTop: 10, width: '100%' }}
            placeholder="Approved WhatsApp template name" value={form.template}
            onChange={(e) => setForm({ ...form, template: e.target.value })} />
        ) : (
          <textarea className="input" style={{ marginTop: 10, width: '100%' }} rows={3}
            placeholder="Message" value={form.text}
            onChange={(e) => setForm({ ...form, text: e.target.value })} />
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary"
            disabled={create.isPending || !form.name || !form.channel_id || (!form.text && !form.template)}
            onClick={() => create.mutate()}>
            {form.scheduled_at ? 'Schedule' : 'Create draft'}
          </button>
        </div>
      </div>

      {(data?.campaigns ?? []).map((cp) => (
        <div key={cp.id} className="card" style={{ marginTop: 12 }}>
          <div className="row">
            <div className="grow">
              <strong>{cp.name}</strong>{' '}
              <span className="chip">{cp.status}</span>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                {cp.channel_name} · {cp.stats.sent}/{cp.stats.total} sent
                {!!cp.stats.failed && ` · ${cp.stats.failed} failed`}
                {!!cp.stats.skipped && ` · ${cp.stats.skipped} opted out`}
                {!!cp.stats.pending && ` · ${cp.stats.pending} pending`}
                {cp.scheduled_at && ` · runs ${new Date(cp.scheduled_at).toLocaleString()}`}
              </div>
            </div>
            {['draft', 'scheduled'].includes(cp.status) && (
              <>
                <button className="btn primary" onClick={() => mutate.mutate({ id: cp.id, action: 'send' })}>
                  Send now
                </button>
                <button className="btn ghost" onClick={() => mutate.mutate({ id: cp.id, action: 'delete' })}>
                  Delete
                </button>
              </>
            )}
            <button className="btn ghost" onClick={() => setOpenId(openId === cp.id ? '' : cp.id)}>
              Details
            </button>
          </div>
          {openId === cp.id && detail.data && (
            <div style={{ marginTop: 10 }}>
              {detail.data.sends.slice(0, 25).map((s) => (
                <div key={s.id} className="row muted" style={{ fontSize: 13, padding: '2px 0' }}>
                  <span className="mono grow">{s.recipient}</span>
                  <span>{s.status}{s.error ? ` — ${s.error}` : ''}</span>
                </div>
              ))}
              {detail.data.sends.length > 25 && (
                <div className="muted" style={{ fontSize: 13 }}>…and {detail.data.sends.length - 25} more</div>
              )}
            </div>
          )}
        </div>
      ))}
      {!!data && !data.campaigns.length && (
        <p className="muted" style={{ marginTop: 14 }}>
          No campaigns yet — audiences come from your <Link to="/contacts">contacts</Link>.
        </p>
      )}
    </div>
  );
}
