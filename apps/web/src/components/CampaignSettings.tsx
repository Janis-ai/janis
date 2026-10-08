import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { CodeBlock } from './bits';
import { Modal } from './Modal';

type SendPolicy = {
  quiet_enabled?: boolean;
  quiet_from?: string;
  quiet_to?: string;
  quiet_tz?: string;
  max_per_recipient_per_day?: number | null;
};
type SuppressionRow = { id: string; address: string; kind: string; reason: string; source: string | null };

/** Workspace-wide campaign machinery — send guardrails + the conversion
 *  webhook token. Lives behind the gear on the Campaigns page rather than
 *  workspace Settings so the knobs sit next to what they govern. */
export function CampaignSettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Campaign settings" onClose={onClose} width={700}>
      <div className="muted" style={{ fontSize: 12, margin: '-4px 0 12px' }}>
        Workspace-wide — applies to every campaign, whichever agent's channel
        it sends through.
      </div>
      <SendPolicyCard />
      <EventTokenCard />
    </Modal>
  );
}

/** Bulk-send guardrails — quiet hours + per-recipient cap + the workspace
 *  suppression list. Applies to campaigns/broadcasts only; replies aren't
 *  throttled. Admin-only. */
function SendPolicyCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      api<{ workspace: { send_policy?: SendPolicy | null } }>('/api/workspace'),
  });
  const { data: sup } = useQuery({
    queryKey: ['suppressions'],
    queryFn: () => api<{ suppressions: SuppressionRow[] }>('/api/suppressions'),
  });
  const saved = data?.workspace.send_policy ?? {};
  const [draft, setDraft] = useState<SendPolicy | null>(null);
  const [msg, setMsg] = useState('');
  const [newAddr, setNewAddr] = useState('');
  const [supQuery, setSupQuery] = useState('');
  const p = draft ?? saved;
  const dirty = draft !== null;
  const upd = (patch: Partial<SendPolicy>) => setDraft({ ...(draft ?? saved), ...patch });

  const save = useMutation({
    mutationFn: () =>
      api('/api/workspace', { method: 'PATCH', body: JSON.stringify({ send_policy: p }) }),
    onSuccess: () => {
      setDraft(null);
      setMsg('Saved — applies to the next queued send.');
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  const addSup = useMutation({
    mutationFn: () =>
      api('/api/suppressions', { method: 'POST', body: JSON.stringify({ address: newAddr }) }),
    onSuccess: () => {
      setNewAddr('');
      void qc.invalidateQueries({ queryKey: ['suppressions'] });
    },
  });
  const delSup = useMutation({
    mutationFn: (id: string) => api(`/api/suppressions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['suppressions'] }),
  });

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong>Sending rules</strong>
      <div className="muted" style={{ fontSize: 13 }}>
        Guardrails for campaign + broadcast sends — quiet hours, per-recipient
        caps, and the never-send list. Checked again at send time — queued
        sends honor changes.
      </div>
      <label className="row" style={{ gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={!!p.quiet_enabled}
          onChange={(e) => upd({ quiet_enabled: e.target.checked })}
        />
        Quiet hours — hold sends between
      </label>
      {p.quiet_enabled && (
        <div className="muted" style={{ fontSize: 12, marginLeft: 24, marginTop: -4 }}>
          Sends due inside the window wait and go out when it ends — they show as
          "held for quiet hours" on the campaign, never dropped.
        </div>
      )}
      {p.quiet_enabled && (
        <div className="row wrap" style={{ gap: 8, marginLeft: 24 }}>
          <input type="time" className="input" value={p.quiet_from ?? '21:00'}
            onChange={(e) => upd({ quiet_from: e.target.value })} />
          <span className="muted">to</span>
          <input type="time" className="input" value={p.quiet_to ?? '08:00'}
            onChange={(e) => upd({ quiet_to: e.target.value })} />
          <input className="input grow" style={{ maxWidth: 220 }}
            placeholder="Timezone (IANA), e.g. America/New_York"
            value={p.quiet_tz ?? ''} onChange={(e) => upd({ quiet_tz: e.target.value })} />
        </div>
      )}
      <label className="row" style={{ gap: 8, fontSize: 13 }}>
        Max sends per recipient / 24h:
        <input className="input" type="number" min="1" style={{ width: 80 }}
          placeholder="∞"
          value={p.max_per_recipient_per_day ?? ''}
          onChange={(e) =>
            upd({ max_per_recipient_per_day: e.target.value ? Number(e.target.value) : null })
          } />
      </label>
      <div className="row">
        <button className="btn primary" disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save policy'}
        </button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4 }}>
        <strong style={{ fontSize: 13 }}>Blocked senders</strong>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
          Never-send addresses — bounces, complaints and dead numbers land here
          automatically. Sends to these show as "skipped — suppressed" on the
          campaign; removing an entry re-enables them.
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input className="input grow" style={{ maxWidth: 300 }}
            placeholder="email or phone to block…"
            value={newAddr} onChange={(e) => setNewAddr(e.target.value)} />
          <button className="btn" disabled={!newAddr.trim() || addSup.isPending}
            onClick={() => addSup.mutate()}>
            Block
          </button>
        </div>
        {(sup?.suppressions?.length ?? 0) > 0 && (
          <input
            placeholder="Search blocked senders…"
            value={supQuery}
            onChange={(e) => setSupQuery(e.target.value)}
            style={{ maxWidth: 280, marginTop: 8 }}
          />
        )}
        {(sup?.suppressions ?? [])
          .filter((s) =>
            supQuery
              ? s.address.toLowerCase().includes(supQuery.toLowerCase()) ||
                s.reason.toLowerCase().includes(supQuery.toLowerCase())
              : true,
          )
          .slice(0, 100)
          .map((s) => (
          <div key={s.id} className="row" style={{ fontSize: 13, padding: '3px 0' }}>
            <span className="mono grow">{s.address}</span>
            <span className="muted">{s.kind} · {s.reason}</span>
            <button className="btn ghost" onClick={() => delSup.mutate(s.id)}>Remove</button>
          </div>
        ))}
        {!!sup && sup.suppressions.length > 100 && !supQuery && (
          <div className="muted" style={{ fontSize: 12 }}>
            Showing first 100 of {sup.suppressions.length} — search to find a specific sender.
          </div>
        )}
        {!!sup && !sup.suppressions.length && (
          <div className="muted" style={{ fontSize: 12 }}>Empty — nobody is blocked.</div>
        )}
      </div>
    </div>
  );
}

/** Conversion-event ingestion — the token + endpoint CRM/marketing systems
 *  POST to when a contact converts. Attributes goal-matched events to the
 *  campaign that asked for them, everything else last-touch. */
function EventTokenCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api<{ workspace: { event_token?: string | null } }>('/api/workspace'),
  });
  const [msg, setMsg] = useState('');
  const token = data?.workspace.event_token ?? null;
  const rotate = useMutation({
    mutationFn: () =>
      api<{ event_token: string }>('/api/workspace/event-token', { method: 'POST' }),
    onSuccess: () => {
      setMsg(token ? 'Rotated — update every integration using the old URL.' : 'Token minted.');
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  const url = token ? `${window.location.origin}/events/${token}` : '';
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
      <strong>Goal tracking</strong>
      <div className="muted" style={{ fontSize: 13 }}>
        When a contact buys, books or signs up, tell Janis — we credit the
        campaign that last messaged them (preferring one whose goal matches the
        event), so campaign stats show conversions and revenue, not just sends.
      </div>
      {token ? (
        <>
          <div className="muted" style={{ fontSize: 13 }}>
            Your webhook URL is <code>{url}</code> — POST it a JSON body like{' '}
            <code>{'{"event":"purchase","email":"who@co.com","value_cents":4999}'}</code>.
            Identify the contact with <code>email</code>, <code>phone</code> or{' '}
            <code>external_id</code>; <code>value_cents</code> is optional.
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            From Zapier or Make: add a <em>Webhooks → POST</em> step, paste the URL
            and map the fields — no code needed.
          </div>
          <CodeBlock
            title="Test it from a terminal"
            code={`curl -XPOST ${url} -H 'content-type: application/json' -d '{"event":"purchase","email":"who@co.com"}'`}
            lang="sh"
          />
        </>
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>
          Mint a token to get your webhook URL.
        </div>
      )}
      <div className="row">
        <button className="btn" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
          {token ? 'Rotate token' : 'Mint token'}
        </button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}
