import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { timeAgo } from '../components/bits';
import { useMe } from '../api/hooks';

type ContactRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  alt_emails?: string[];
  alt_phones?: string[];
  tags?: string[];
  has_avatar: boolean;
  notes: string | null;
  identities?: number;
  conversations?: number;
  last_message_at: string | null;
  created_at: string;
};

type ContactDetail = {
  contact: ContactRow;
  identities: { id: string; platform_user_id: string; channel_id: string; channel_kind: string; channel_name: string }[];
  conversations: {
    id: string;
    state: string;
    agent_name: string;
    last_message_at: string | null;
    last_message_preview: string | null;
  }[];
  possible_duplicates: { id: string; name: string | null; email: string | null; phone: string | null; match?: string }[];
};

const displayName = (c: { name: string | null; email: string | null; phone: string | null }) =>
  c.name ?? c.email ?? c.phone ?? 'Unknown';

export function Contacts() {
  const [q, setQ] = useState('');
  const { data: me } = useMe();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState('');
  const { data } = useQuery({
    queryKey: ['contacts', q],
    queryFn: () => api<{ contacts: ContactRow[] }>(`/api/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  });
  const importCsv = useMutation({
    mutationFn: async (file: File) => {
      const csv = await file.text();
      const name = file.name.replace(/\.csv$/i, '');
      return api<{ list_id: string; created: number; matched: number; skipped: number }>(
        '/api/lists/import',
        { method: 'POST', body: JSON.stringify({ name, csv }) },
      );
    },
    onSuccess: (r) => {
      setImportMsg(`Imported → list: ${r.created} new, ${r.matched} matched existing${r.skipped ? `, ${r.skipped} skipped (bad rows)` : ''}`);
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      void qc.invalidateQueries({ queryKey: ['lists'] });
    },
    onError: (e) => setImportMsg(e.message),
  });

  return (
    <>
      <div className="page-head">
        <h1>Contacts</h1>
        <input
          className="grow"
          style={{ maxWidth: 320 }}
          placeholder="Search name, email, phone…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {me?.user.role === 'admin' && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importCsv.mutate(f);
                e.target.value = '';
              }}
            />
            <button className="btn" disabled={importCsv.isPending} onClick={() => fileRef.current?.click()}>
              {importCsv.isPending ? 'Importing…' : 'Import CSV'}
            </button>
          </>
        )}
      </div>
      {importMsg && <div className="muted" style={{ marginBottom: 8 }}>{importMsg}</div>}
      <div className="card">
        {data?.contacts.length === 0 && (
          <div className="muted">No contacts yet — they appear as conversations arrive.</div>
        )}
        {data?.contacts.map((c) => (
          <Link key={c.id} to={`/contacts/${c.id}`} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', color: 'inherit', textDecoration: 'none' }}>
            <strong className="grow">{displayName(c)}</strong>
            {!!c.tags?.length && (
              <span>{c.tags.slice(0, 4).map((t) => <span key={t} className="chip" style={{ marginRight: 4 }}>{t}</span>)}</span>
            )}
            <span className="muted">{[c.email, c.phone].filter(Boolean).join(' · ')}</span>
            <span className="muted">
              {(c.identities ?? 0) > 1 ? `${c.identities} channels` : ''}
              {(c.conversations ?? 0) > 0 ? ` · ${c.conversations} conversation${c.conversations === 1 ? '' : 's'}` : ''}
            </span>
            <span className="muted">{c.last_message_at ? timeAgo(c.last_message_at) : ''}</span>
          </Link>
        ))}
      </div>
    </>
  );
}

export function ContactDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const isAdmin = me?.user.role === 'admin';
  const { data } = useQuery({
    queryKey: ['contact', id],
    queryFn: () => api<ContactDetail>(`/api/contacts/${id}`),
    enabled: !!id,
  });
  const [edit, setEdit] = useState<{ name: string; email: string; phone: string; notes: string; tags: string } | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, string | string[] | null>) =>
      api(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ['contact', id] });
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    },
  });
  const merge = useMutation({
    mutationFn: (otherId: string) =>
      api(`/api/contacts/${id}/merge`, { method: 'POST', body: JSON.stringify({ other_id: otherId }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contact', id] });
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    },
  });
  const nav = useNavigate();
  const del = useMutation({
    mutationFn: (purge: boolean) =>
      api(`/api/contacts/${id}${purge ? '?mode=purge' : ''}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      nav('/contacts');
    },
  });

  if (!data) return <div className="muted">Loading…</div>;
  const c = data.contact;

  return (
    <>
      <div className="page-head">
        <h1>{displayName(c)}</h1>
        {!edit && <button className="btn" onClick={() => setEdit({ name: c.name ?? '', email: c.email ?? '', phone: c.phone ?? '', notes: c.notes ?? '', tags: (c.tags ?? []).join(', ') })}>Edit</button>}
        {isAdmin && (
          <>
            <a className="btn" href={`/api/contacts/${id}/export`} target="_blank" rel="noreferrer">
              Export
            </a>
            <button
              className="btn danger"
              onClick={() => {
                if (!confirm(`Delete ${displayName(c)}? Channel identities are removed; conversations stay but lose the contact link.`)) return;
                if (confirm('GDPR purge? OK = also delete every conversation and transcript for this person. Cancel = keep anonymized transcripts.')) {
                  del.mutate(true);
                } else {
                  del.mutate(false);
                }
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>

      {edit && (
        <div className="card" style={{ marginBottom: 12 }}>
          <strong>Edit contact</strong>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, maxWidth: 420 }}>
            <input placeholder="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <input placeholder="Email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
            <input placeholder="Phone" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
            <input placeholder="Tags (comma-separated — used for campaign audiences)" value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} />
            <textarea placeholder="Notes" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
            <div className="row">
              <button
                className="btn primary"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({
                    name: edit.name || null,
                    email: edit.email || null,
                    phone: edit.phone || null,
                    notes: edit.notes || null,
                    tags: edit.tags.split(',').map((t) => t.trim()).filter(Boolean),
                  })
                }
              >
                Save
              </button>
              <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <strong>Details</strong>
        <div className="muted" style={{ marginTop: 8 }}>
          <div>Email: {c.email ?? '—'}</div>
          {!!c.alt_emails?.length && <div>Also emails: {c.alt_emails.join(', ')}</div>}
          <div>Phone: {c.phone ?? '—'}</div>
          {!!c.alt_phones?.length && <div>Also phones: {c.alt_phones.join(', ')}</div>}
          {!!c.tags?.length && (
            <div style={{ marginTop: 6 }}>
              Tags: {c.tags.map((t) => <span key={t} className="chip" style={{ marginRight: 4 }}>{t}</span>)}
            </div>
          )}
          {c.notes && <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{c.notes}</div>}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <strong>Channel identities</strong>
        {data.identities.length === 0 && <div className="muted" style={{ marginTop: 8 }}>None linked.</div>}
        {data.identities.map((i) => (
          <IdentityRow key={i.id} identity={i} contactId={id!} />
        ))}
      </div>

      {data.possible_duplicates.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>Possible duplicates</strong>
          {data.possible_duplicates.map((d) => (
            <div key={d.id} className="row" style={{ marginTop: 6 }}>
              <span className="grow">{displayName(d)}</span>
              {d.match && <span className="chip">{d.match}</span>}
              <span className="muted">{[d.email, d.phone].filter(Boolean).join(' · ')}</span>
              {isAdmin && (
                <button
                  className="btn"
                  disabled={merge.isPending}
                  onClick={() => {
                    if (confirm(`Merge ${displayName(d)} (${[d.email, d.phone].filter(Boolean).join(', ') || 'no contact info'}) into ${displayName(c)} (${[c.email, c.phone].filter(Boolean).join(', ') || 'no contact info'})? Their conversations, identities, and any differing email/phone move over.`))
                      merge.mutate(d.id);
                  }}
                >
                  Merge into this contact
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <strong>Conversations</strong>
        {data.conversations.length === 0 && <div className="muted" style={{ marginTop: 8 }}>None yet.</div>}
        {data.conversations.map((v) => (
          <Link key={v.id} to={`/conversations/${v.id}`} className="row" style={{ padding: '6px 0', color: 'inherit', textDecoration: 'none' }}>
            <span className={`badge ${v.state}`}>{v.state}</span>
            <span className="grow">{v.agent_name} — {v.last_message_preview ?? ''}</span>
            <span className="muted">{v.last_message_at ? timeAgo(v.last_message_at) : ''}</span>
          </Link>
        ))}
      </div>
    </>
  );
}

/** One channel identity — shows the platform id and, for initiatable
 *  channels (sms/email/whatsapp), an inline outbound composer. */
function IdentityRow({
  identity: i,
  contactId,
}: {
  identity: { id: string; platform_user_id: string; channel_id: string; channel_kind: string; channel_name: string };
  contactId: string;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [template, setTemplate] = useState('');
  const [err, setErr] = useState('');
  const canSend = ['sms', 'whatsapp', 'email', 'gmail', 'outlook'].includes(i.channel_kind);
  const send = useMutation({
    mutationFn: () =>
      api<{ conversation_id?: string; error?: string }>(`/api/channels/${i.channel_id}/send`, {
        method: 'POST',
        body: JSON.stringify({
          to: i.platform_user_id,
          text,
          ...(i.channel_kind === 'whatsapp' && template.trim()
            ? { whatsapp_template: { name: template.trim() } }
            : {}),
        }),
      }),
    onSuccess: (r) => {
      if (r.error) { setErr(r.error); return; }
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['contact', contactId] });
      if (r.conversation_id) navigate(`/conversations/${r.conversation_id}`);
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'send failed'),
  });
  return (
    <div style={{ marginTop: 6 }}>
      <div className="row">
        <span className="badge">{i.channel_kind}</span>
        <span className="grow">{i.channel_name}</span>
        <span className="mono muted">{i.platform_user_id}</span>
        {canSend && (
          <button className="btn" onClick={() => setOpen((o) => !o)}>
            {open ? 'Close' : 'Message'}
          </button>
        )}
      </div>
      {open && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {i.channel_kind === 'whatsapp' && (
            <>
              <input
                placeholder="Approved template name (e.g. hello_world)"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
              />
              <div className="muted" style={{ fontSize: 12 }}>
                Outside the 24-hour reply window WhatsApp requires an approved template.
              </div>
            </>
          )}
          <textarea
            placeholder="Message text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
          />
          <div className="row">
            <button
              className="btn primary"
              disabled={send.isPending || (!text.trim() && !(i.channel_kind === 'whatsapp' && template.trim()))}
              onClick={() => { setErr(''); send.mutate(); }}
            >
              {send.isPending ? 'Sending…' : 'Send'}
            </button>
            {err && <span className="error" style={{ fontSize: 12 }}>{err}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
