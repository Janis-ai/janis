// Campaigns — proactive outbound: pick a channel + audience filter, send or schedule.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useConfirm } from '../components/Prompt';
import { useChannels } from '../api/hooks';
import { usePageTitle } from '../lib/title';

const SENDABLE = ['sms', 'whatsapp', 'email', 'gmail', 'outlook'];

type Stats = { total: number; sent: number; replied: number; converted?: number; failed: number; pending: number; skipped: number };
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

/** Human-readable send outcomes — the "why" behind each status code. */
const SEND_STATUS: Record<string, string> = {
  pending: 'queued',
  sent: 'sent',
  failed: 'failed',
  skipped_opted_out: 'skipped — opted out',
  skipped_suppressed: 'skipped — blocked (bounce/complaint)',
  skipped_frequency_cap: 'skipped — 24h frequency cap',
  skipped_cancelled: 'skipped — campaign stopped',
};

export default function Campaigns() {
  usePageTitle('Campaigns');
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
  const [confirmEl, confirm] = useConfirm();
  const detail = useQuery({
    queryKey: ['campaign', openId],
    enabled: !!openId,
    queryFn: () => api<{ stats: Stats; sends: SendRow[] }>(`/api/campaigns/${openId}`),
    refetchInterval: 10_000,
  });

  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');
  type Action = 'send' | 'delete' | 'pause' | 'resume' | 'cancel';
  const act = (id: string, action: Action) =>
    action === 'delete'
      ? api<{ warnings?: string[] }>(`/api/campaigns/${id}`, { method: 'DELETE' })
      : api<{ warnings?: string[] }>(`/api/campaigns/${id}/${action}`, { method: 'POST' });
  const mutate = useMutation({
    mutationFn: ({ id, action }: { id: string; action: Action }) => act(id, action),
    onSuccess: (r) => {
      setWarn(r?.warnings?.length ? `Send queued — but check: ${r.warnings.join(' ')}` : '');
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onError: (e) => setErr(e.message),
  });

  type StepDraft = {
    delay_hrs: string;
    text: string;
    cond: string;
    subject: string;
    template: string;
  };
  const [form, setForm] = useState({
    name: '', channel_id: '', subject: '', text: '', template: '', q: '', scheduled_at: '',
    has_email: false, has_phone: false, active_days: '', never_replied: false,
    steps: [] as StepDraft[],
    agent_instructions: '', list_id: '', tags: '',
    enrollment: 'once', send_cap: '', goal: '',
  });
  const setStep = (i: number, patch: Partial<StepDraft>) =>
    setForm((f) => ({ ...f, steps: f.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
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
      steps: [] as StepDraft[],
      agent_instructions: '', list_id: '', tags: '',
      enrollment: 'once', send_cap: '', goal: '',
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
          steps: form.steps.length
            ? form.steps
                .filter((s) => s.delay_hrs && (s.text || s.template))
                .map((s) => ({
                  delay_minutes: Math.round(Number(s.delay_hrs) * 60),
                  text: s.text || undefined,
                  subject: isEmail && s.subject.trim() ? s.subject.trim() : undefined,
                  condition: s.cond as 'if_not_replied',
                  whatsapp_template:
                    kind === 'whatsapp' && s.template.trim()
                      ? { name: s.template.trim() }
                      : undefined,
                }))
            : undefined,
          agent_instructions: form.agent_instructions.trim() || undefined,
          enrollment: form.enrollment,
          send_cap: form.send_cap ? Number(form.send_cap) : undefined,
          goal: form.goal.trim() || undefined,
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
      {confirmEl}
      <h1>Campaigns</h1>
      <p className="muted">
        Proactive sends to contacts on a channel. SMS, email, Outlook and Gmail open new
        threads; WhatsApp requires an approved template. Opted-out contacts are skipped
        and recorded.
      </p>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {warn && <div className="error" style={{ marginBottom: 12, background: '#3a2d00', borderColor: '#8a6d00' }}>{warn}</div>}

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
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Pick a channel, leave the date blank to save a draft, or set one to schedule.
        </div>
        <div className="row" style={{ gap: 10, marginTop: 10 }}>
          <select className="input" value={form.enrollment}
            onChange={(e) => setForm({ ...form, enrollment: e.target.value })}>
            <option value="once">One-time blast</option>
            <option value="continuous">Ongoing — auto-enroll new matches + webhook</option>
          </select>
          <input className="input" type="number" min="1" style={{ width: 150 }}
            placeholder="Max sends (cap)" value={form.send_cap}
            onChange={(e) => setForm({ ...form, send_cap: e.target.value })} />
          <input className="input" style={{ width: 180 }}
            placeholder="Goal event (e.g. purchase)" value={form.goal}
            onChange={(e) => setForm({ ...form, goal: e.target.value })} />
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {form.enrollment === 'continuous'
            ? 'Ongoing: new contacts matching the audience enroll automatically, and external tools can enroll via webhook.'
            : 'One-time: the audience is resolved when the campaign runs.'}
          {' '}Max sends caps the total (blank = unlimited). Goal event is the conversion name reported to your events endpoint that marks this campaign a success.
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
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="muted grow" style={{ fontSize: 13 }}>
              Follow-up steps — each reaches recipients matching its condition,
              delayed after the previous step (up to 10) — the "if" dropdown chooses
              who gets it, based on how the previous send ended
            </span>
            {form.steps.length < 10 && (
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    steps: [
                      ...f.steps,
                      { delay_hrs: '', text: '', cond: 'if_not_replied', subject: '', template: '' },
                    ],
                  }))
                }
              >
                + Add step
              </button>
            )}
          </div>
          {form.steps.map((s, i) => (
            <div key={i} className="card" style={{ padding: 10, marginBottom: 8 }}>
              <div className="row wrap" style={{ gap: 10 }}>
                <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>
                  Step {i + 2}
                </span>
                <input
                  className="input" type="number" min="1" style={{ width: 110 }}
                  title={`Hours after step ${i + 1}`}
                  placeholder="Wait hrs" value={s.delay_hrs}
                  onChange={(e) => setStep(i, { delay_hrs: e.target.value })} />
                <select className="input" style={{ width: 230 }}
                  value={s.cond}
                  onChange={(e) => setStep(i, { cond: e.target.value })}>
                  <option value="if_not_replied">if no reply (classic drip)</option>
                  <option value="if_replied">if they replied</option>
                  <option value="if_converted">if converted (goal event)</option>
                  <option value="if_not_converted">if not converted</option>
                  <option value="always">everyone who got the previous step</option>
                </select>
                <button
                  type="button" className="btn icon" title="Remove step"
                  style={{ marginLeft: 'auto' }}
                  onClick={() =>
                    setForm((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))
                  }
                >
                  ×
                </button>
              </div>
              {isEmail && (
                <input className="input" style={{ marginTop: 8, width: '100%' }}
                  placeholder={`Step ${i + 2} subject (optional — defaults to campaign subject)`}
                  value={s.subject}
                  onChange={(e) => setStep(i, { subject: e.target.value })} />
              )}
              {kind === 'whatsapp' ? (
                <input className="input" style={{ marginTop: 8, width: '100%' }}
                  placeholder="Approved WhatsApp template name for this step"
                  value={s.template}
                  onChange={(e) => setStep(i, { template: e.target.value })} />
              ) : (
                <textarea className="input" style={{ marginTop: 8, width: '100%' }} rows={2}
                  placeholder={`Step ${i + 2} message`}
                  value={s.text}
                  onChange={(e) => setStep(i, { text: e.target.value })} />
              )}
            </div>
          ))}
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
                {cp.channel_name} · replies → {cp.agent_name}
                {cp.scheduled_at && ` · runs ${new Date(cp.scheduled_at).toLocaleString()}`}
              </div>
              <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                <span className="chip">{cp.stats.sent}/{cp.stats.total} sent</span>
                {!!cp.stats.replied && <span className="chip">{cp.stats.replied} replied</span>}
                {!!cp.stats.converted && <span className="chip">{cp.stats.converted} converted</span>}
                {!!cp.stats.pending && <span className="chip">{cp.stats.pending} queued</span>}
                {!!cp.stats.failed && <span className="chip" style={{ color: 'var(--danger)' }}>{cp.stats.failed} failed</span>}
                {!!cp.stats.skipped && <span className="chip">{cp.stats.skipped} skipped (opted out/suppressed)</span>}
              </div>
            </div>
            {['draft', 'scheduled'].includes(cp.status) && (
              <>
                <button className="btn primary" onClick={() => mutate.mutate({ id: cp.id, action: 'send' })}>
                  Send now
                </button>
                <button
                  className="btn ghost"
                  onClick={async () => {
                    if (await confirm(`Delete campaign "${cp.name}"? ${cp.stats.total ? `Its ${cp.stats.total} queued send${cp.stats.total === 1 ? '' : 's'} will be dropped.` : 'This cannot be undone.'}`, [{ key: 'ok', label: 'Delete', danger: true }]))
                      mutate.mutate({ id: cp.id, action: 'delete' });
                  }}
                >
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
                onClick={async () => {
                  if (await confirm('Cancel this campaign? Pending sends will be skipped.', [{ key: 'ok', label: 'Cancel campaign', danger: true }]))
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
                    {s.step ? `step ${s.step} · ` : ''}
                    {s.status === 'pending' && s.error?.startsWith('held')
                      ? s.error
                      : `${SEND_STATUS[s.status] ?? s.status}${s.replied_at ? ' · replied' : ''}${s.error ? ` — ${s.error}` : ''}`}
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
