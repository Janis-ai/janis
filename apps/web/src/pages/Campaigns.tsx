// Campaigns — proactive outbound: pick a channel + audience filter, send or schedule.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useChannels } from '../api/hooks';

const SENDABLE = ['sms', 'whatsapp', 'email', 'gmail', 'outlook'];

type Stats = { total: number; sent: number; replied: number; failed: number; pending: number; skipped: number };
type CampaignRow = {
  id: string;
  name: string;
  status: string;
  channel_name: string;
  channel_kind: string;
  agent_name: string;
  enrollment?: string;
  enroll_token?: string | null;
  scheduled_at: string | null;
  stats: Stats;
};
type SendRow = { id: string; recipient: string; step?: number; status: string; error: string | null; sent_at: string | null; replied_at?: string | null };

export default function Campaigns() {
  const qc = useQueryClient();
  const { data: chans } = useChannels();
  const channels = (chans?.channels ?? []).filter((c) => SENDABLE.includes(c.kind));
  const { data: listsData } = useQuery({
    queryKey: ['lists'],
    queryFn: () => api<{ lists: { id: string; name: string; members: number }[] }>('/api/lists'),
  });
  const lists = listsData?.lists ?? [];
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
  type Action = 'send' | 'delete' | 'pause' | 'resume' | 'cancel';
  const act = (id: string, action: Action) =>
    action === 'delete'
      ? api(`/api/campaigns/${id}`, { method: 'DELETE' })
      : api(`/api/campaigns/${id}/${action}`, { method: 'POST' });
  const mutate = useMutation({
    mutationFn: ({ id, action }: { id: string; action: Action }) => act(id, action),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['campaigns'] }),
    onError: (e) => setErr(e.message),
  });

  const [form, setForm] = useState({
    name: '', channel_id: '', subject: '', text: '', template: '', q: '', scheduled_at: '',
    has_email: false, has_phone: false, active_days: '', never_replied: false,
    step_delay: '', step_text: '', agent_instructions: '', list_id: '', tags: '',
    enrollment: 'once', send_cap: '',
  });
  const segment = () => ({
    ...(form.q ? { q: form.q } : {}),
    ...(form.list_id ? { list_id: form.list_id } : {}),
    ...(form.tags.trim() ? { tags: form.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) } : {}),
    ...(form.has_email ? { has_email: true } : {}),
    ...(form.has_phone ? { has_phone: true } : {}),
    ...(form.active_days ? { active_within_days: Number(form.active_days) } : {}),
    ...(form.never_replied ? { never_replied: true } : {}),
  });
  const preview = useQuery({
    queryKey: ['campaign-preview', form.channel_id, form.q, form.list_id, form.tags, form.has_email, form.has_phone, form.active_days, form.never_replied],
    enabled: !!form.channel_id,
    queryFn: () =>
      api<{ total: number; opted_out: number; unreachable: number }>('/api/campaigns/preview', {
        method: 'POST',
        body: JSON.stringify({ channel_id: form.channel_id, segment: segment() }),
      }),
  });
  const resetForm = () =>
    setForm({
      name: '', channel_id: '', subject: '', text: '', template: '', q: '', scheduled_at: '',
      has_email: false, has_phone: false, active_days: '', never_replied: false,
      step_delay: '', step_text: '', agent_instructions: '', list_id: '', tags: '',
      enrollment: 'once', send_cap: '',
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
          segment: segment(),
          steps:
            form.step_text && form.step_delay
              ? [{ delay_minutes: Math.round(Number(form.step_delay) * 60), text: form.step_text }]
              : undefined,
          agent_instructions: form.agent_instructions.trim() || undefined,
          enrollment: form.enrollment,
          send_cap: form.send_cap ? Number(form.send_cap) : undefined,
          scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).toISOString() : undefined,
        }),
      }),
    onSuccess: () => {
      resetForm();
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
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind}) — agent: {c.agent_name}
              </option>
            ))}
          </select>
          <input className="input" type="datetime-local" title="Schedule (blank = draft)"
            value={form.scheduled_at}
            onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })} />
        </div>
        <div className="row" style={{ gap: 10, marginTop: 10 }}>
          <select className="input" value={form.enrollment}
            title="one-time resolves the audience at send; ongoing keeps enrolling new matching contacts and accepts webhook enrollments"
            onChange={(e) => setForm({ ...form, enrollment: e.target.value })}>
            <option value="once">One-time blast</option>
            <option value="continuous">Ongoing — auto-enroll new matches + webhook</option>
          </select>
          <input className="input" type="number" min="1" style={{ width: 150 }}
            title="Hard cap on total sends — leave blank for unlimited"
            placeholder="Max sends (cap)" value={form.send_cap}
            onChange={(e) => setForm({ ...form, send_cap: e.target.value })} />
        </div>
        <div className="row wrap" style={{ gap: 10, marginTop: 10 }}>
          <select className="input" value={form.list_id}
            title="Static audience — contacts imported or added to a list"
            onChange={(e) => setForm({ ...form, list_id: e.target.value })}>
            <option value="">Audience: all contacts…</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>List: {l.name} ({l.members})</option>
            ))}
          </select>
          <input className="input grow" placeholder="Refine: name/email/phone contains…"
            value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} />
          <input className="input" style={{ width: 170 }} placeholder="tag, tag…"
            title="Contacts matching any of these tags"
            value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          {preview.data && (
            <span className="muted" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
              {preview.data.total} recipients
              {!!preview.data.opted_out && ` (${preview.data.opted_out} opted out)`}
              {!!preview.data.unreachable && ` (${preview.data.unreachable} unreachable on this channel)`}
            </span>
          )}
        </div>
        <div className="row wrap muted" style={{ gap: 14, marginTop: 8, fontSize: 13 }}>
          <label><input type="checkbox" checked={form.has_email}
            onChange={(e) => setForm({ ...form, has_email: e.target.checked })} /> has email</label>
          <label><input type="checkbox" checked={form.has_phone}
            onChange={(e) => setForm({ ...form, has_phone: e.target.checked })} /> has phone</label>
          <label><input type="checkbox" checked={form.never_replied}
            onChange={(e) => setForm({ ...form, never_replied: e.target.checked })} /> never replied</label>
          <label>active within <input className="input" type="number" min="1" max="365"
            style={{ width: 64 }} placeholder="days" value={form.active_days}
            onChange={(e) => setForm({ ...form, active_days: e.target.value })} /> days</label>
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
        {!!form.channel_id && (
          <textarea className="input" style={{ marginTop: 10, width: '100%' }} rows={2}
            placeholder={`Reply handling for ${channels.find((c) => c.id === form.channel_id)?.agent_name ?? 'the agent'} — optional. e.g. "This is a win-back offer; answer questions and help them reactivate. Offer 20% off if asked."`}
            value={form.agent_instructions}
            onChange={(e) => setForm({ ...form, agent_instructions: e.target.value })} />
        )}
        <div className="row" style={{ gap: 10, marginTop: 10 }}>
          <input className="input" type="number" min="1" style={{ width: 110 }}
            title="Hours after the first send"
            placeholder="Follow-up hrs" value={form.step_delay}
            onChange={(e) => setForm({ ...form, step_delay: e.target.value })} />
          <input className="input grow"
            placeholder="Follow-up text — goes to non-repliers (optional)"
            value={form.step_text} onChange={(e) => setForm({ ...form, step_text: e.target.value })} />
        </div>
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
              <span className="chip">{cp.enrollment === 'continuous' ? 'ongoing' : cp.status}</span>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                {cp.channel_name} · replies → {cp.agent_name} · {cp.stats.sent}/{cp.stats.total} sent
                {!!cp.stats.replied && ` · ${cp.stats.replied} replied`}
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
            {['sending', 'scheduled'].includes(cp.status) && (
              <button className="btn ghost" onClick={() => mutate.mutate({ id: cp.id, action: 'pause' })}>
                Pause
              </button>
            )}
            {cp.status === 'paused' && (
              <button className="btn primary" onClick={() => mutate.mutate({ id: cp.id, action: 'resume' })}>
                Resume
              </button>
            )}
            {['sending', 'paused', 'scheduled'].includes(cp.status) && (
              <button
                className="btn ghost"
                onClick={() => {
                  if (confirm('Cancel this campaign? Pending sends will be skipped.'))
                    mutate.mutate({ id: cp.id, action: 'cancel' });
                }}
              >
                Cancel
              </button>
            )}
            <button className="btn ghost" onClick={() => setOpenId(openId === cp.id ? '' : cp.id)}>
              Details
            </button>
          </div>
          {openId === cp.id && detail.data && (
            <div style={{ marginTop: 10 }}>
              {cp.enrollment === 'continuous' && cp.enroll_token && (
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                  Webhook enroll:{' '}
                  <code>POST {location.origin}/enroll/{cp.enroll_token}</code>{' '}
                  — body: {'{email?|phone?|external_id?, name?, tags?}'}
                </div>
              )}
              {detail.data.sends.slice(0, 25).map((s) => (
                <div key={s.id} className="row muted" style={{ fontSize: 13, padding: '2px 0' }}>
                  <span className="mono grow">{s.recipient}</span>
                  <span>
                    {s.step ? `step ${s.step} · ` : ''}{s.status}
                    {s.replied_at ? ' · replied' : ''}
                    {s.error ? ` — ${s.error}` : ''}
                  </span>
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
