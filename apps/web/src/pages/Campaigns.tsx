// Campaigns — proactive outbound: pick a channel + audience filter, send or schedule.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useConfirm } from '../components/Prompt';
import { AgentScopePicker } from '../components/AgentScopePicker';
import { useChannels } from '../api/hooks';
import { useContextAgent } from '../lib/agentContext';
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
type StepDef = { delay_minutes: number; text?: string; subject?: string; condition?: string; whatsapp_template?: { name: string } };
type CampaignDetail = {
  campaign: {
    id: string; name: string; text: string; subject?: string | null;
    whatsapp_template?: { name: string } | null;
    channel_id: string; channel_name?: string; channel_kind?: string; agent_name?: string;
    status: string; scheduled_at: string | null; created_at?: string;
    segment?: {
      q?: string; list_id?: string; tags?: string[]; channel_id?: string;
      has_email?: boolean; has_phone?: boolean; active_within_days?: number; never_replied?: boolean;
    };
    steps?: StepDef[];
    agent_instructions?: string | null; enrollment?: string; send_cap?: number | null; goal?: string | null;
  };
  stats: Stats;
  sends: SendRow[];
};

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

const STEP_COND: Record<string, string> = {
  if_not_replied: 'if no reply',
  if_replied: 'if they replied',
  if_converted: 'if converted',
  if_not_converted: 'if not converted',
  always: 'everyone who got the previous step',
};

function fmtDelay(mins: number) {
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

/** Per-step rollup of the send rows — step 0 is the initial blast. */
function stepStats(sends: SendRow[], step: number) {
  const rows = sends.filter((s) => (s.step ?? 0) === step);
  return {
    sent: rows.filter((s) => s.status === 'sent').length,
    pending: rows.filter((s) => s.status === 'pending').length,
    failed: rows.filter((s) => s.status === 'failed').length,
    skipped: rows.filter((s) => s.status.startsWith('skipped_')).length,
    replied: rows.filter((s) => s.replied_at).length,
  };
}

function statChips(sends: SendRow[], step: number) {
  const s = stepStats(sends, step);
  const bits = [`${s.sent} sent`];
  if (s.pending) bits.push(`${s.pending} queued`);
  if (s.replied) bits.push(`${s.replied} replied`);
  if (s.failed) bits.push(`${s.failed} failed`);
  if (s.skipped) bits.push(`${s.skipped} skipped`);
  return bits.join(' · ');
}

export default function Campaigns({ agentId: routeAgent }: { agentId?: string } = {}) {
  usePageTitle('Campaigns');
  const qc = useQueryClient();
  const { data: chans } = useChannels();
  // Agent scoping is app context (URL agent or the persisted pick); the
  // scoped view sends through that agent's channels only.
  const ctxAgent = useContextAgent();
  const agentId = routeAgent ?? ctxAgent ?? undefined;
  const channels = (chans?.channels ?? []).filter(
    (c) => SENDABLE.includes(c.kind) && (!agentId || c.agent_id === agentId),
  );
  const { data: listsData } = useQuery({
    queryKey: ['lists'],
    queryFn: () => api<{ lists: { id: string; name: string; members: number }[] }>('/api/lists'),
  });
  const lists = listsData?.lists ?? [];
  const { data } = useQuery({
    queryKey: ['campaigns', agentId ?? ''],
    queryFn: () =>
      api<{ campaigns: CampaignRow[] }>(`/api/campaigns${agentId ? `?agent_id=${agentId}` : ''}`),
    refetchInterval: 10_000,
  });
  const [openId, setOpenId] = useState('');
  const [confirmEl, confirm] = useConfirm();
  const detail = useQuery({
    queryKey: ['campaign', openId],
    enabled: !!openId,
    queryFn: () => api<CampaignDetail>(`/api/campaigns/${openId}`),
    refetchInterval: 10_000,
  });

  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');
  type Action = 'send' | 'delete' | 'pause' | 'resume';
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
      <h1>
        Campaigns
        <span style={{ marginLeft: 8 }}>
          <AgentScopePicker slug="campaigns" value={agentId} />
        </span>
      </h1>
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
          {form.scheduled_at && new Date(form.scheduled_at).getTime() < Date.now() && (
            <span style={{ color: 'var(--warn, #b45309)' }}>
              {' '}— that time has already passed, so it sends immediately on save
            </span>
          )}
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
              <button className="btn primary" onClick={() => mutate.mutate({ id: cp.id, action: 'send' })}>
                Send now
              </button>
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
            <button
              className="btn ghost"
              onClick={async () => {
                const active = ['sending', 'paused'].includes(cp.status);
                if (
                  await confirm(
                    `Delete campaign "${cp.name}"?${active ? ' Queued sends are dropped.' : ''}${cp.stats.total ? ' Its send history is removed.' : ''} This cannot be undone.`,
                    [{ key: 'ok', label: 'Delete campaign', danger: true }],
                  )
                )
                  mutate.mutate({ id: cp.id, action: 'delete' });
              }}
            >
              Delete
            </button>
            <button className="btn ghost" onClick={() => setOpenId(openId === cp.id ? '' : cp.id)}>
              Details
            </button>
          </div>
          {openId === cp.id && detail.data && (() => {
            const dc = detail.data.campaign;
            const seg = dc.segment ?? {};
            const audience: string[] = [];
            if (seg.list_id)
              audience.push(`list: ${lists.find((l) => l.id === seg.list_id)?.name ?? seg.list_id}`);
            if (seg.q) audience.push(`"${seg.q}"`);
            if (seg.tags?.length) audience.push(`tags: ${seg.tags.join(', ')}`);
            if (seg.channel_id)
              audience.push(`identity on ${chans?.channels.find((c) => c.id === seg.channel_id)?.name ?? 'a channel'}`);
            if (seg.has_email) audience.push('has email');
            if (seg.has_phone) audience.push('has phone');
            if (seg.active_within_days) audience.push(`active within ${seg.active_within_days}d`);
            if (seg.never_replied) audience.push('never replied');
            const steps = dc.steps ?? [];
            return (
            <div style={{ marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                {dc.channel_name && <>{dc.channel_name} ({dc.channel_kind}) · replies → {dc.agent_name} · </>}
                {dc.enrollment === 'continuous' ? 'ongoing' : 'one-time'}
                {dc.created_at && ` · created ${new Date(dc.created_at).toLocaleString()}`}
                {dc.scheduled_at && ` · runs ${new Date(dc.scheduled_at).toLocaleString()}`}
                {!!dc.send_cap && ` · capped at ${dc.send_cap} sends`}
                {!!dc.goal && ` · goal: ${dc.goal}`}
                <br />
                Audience: {audience.length ? audience.join(' · ') : 'all contacts reachable on the channel'}
              </div>
              <div className="card" style={{ padding: 10, marginBottom: 8 }}>
                <div className="row" style={{ fontSize: 13 }}>
                  <strong className="grow">Step 1 — initial send</strong>
                  <span className="muted">{statChips(detail.data.sends, 0)}</span>
                </div>
                {dc.subject && <div style={{ fontSize: 13, marginTop: 6 }}>Subject: {dc.subject}</div>}
                <div className="muted" style={{ fontSize: 13, marginTop: 4, whiteSpace: 'pre-wrap' }}>
                  {dc.whatsapp_template ? `WhatsApp template: ${dc.whatsapp_template.name}` : dc.text}
                </div>
              </div>
              {steps.map((s, i) => (
                <div key={i} className="card" style={{ padding: 10, marginBottom: 8 }}>
                  <div className="row" style={{ fontSize: 13 }}>
                    <strong className="grow">
                      Step {i + 2} — +{fmtDelay(s.delay_minutes)} · {STEP_COND[s.condition ?? 'if_not_replied'] ?? s.condition}
                    </strong>
                    <span className="muted">{statChips(detail.data.sends, i + 1)}</span>
                  </div>
                  {s.subject && <div style={{ fontSize: 13, marginTop: 6 }}>Subject: {s.subject}</div>}
                  <div className="muted" style={{ fontSize: 13, marginTop: 4, whiteSpace: 'pre-wrap' }}>
                    {s.whatsapp_template ? `WhatsApp template: ${s.whatsapp_template.name}` : s.text ?? dc.text}
                  </div>
                </div>
              ))}
              {dc.agent_instructions && (
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                  Reply handling for the agent: {dc.agent_instructions}
                </div>
              )}
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
              {!detail.data.sends.length && (
                <div className="muted" style={{ fontSize: 13 }}>No sends yet.</div>
              )}
            </div>
            );
          })()}
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
