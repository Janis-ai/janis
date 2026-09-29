import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { timeAgo } from '../components/bits';
import { useMe } from '../api/hooks';

type ContactRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  has_avatar: boolean;
  notes: string | null;
  identities?: number;
  conversations?: number;
  last_message_at: string | null;
  created_at: string;
};

type ContactDetail = {
  contact: ContactRow;
  identities: { id: string; platform_user_id: string; channel_kind: string; channel_name: string }[];
  conversations: {
    id: string;
    state: string;
    agent_name: string;
    last_message_at: string | null;
    last_message_preview: string | null;
  }[];
  possible_duplicates: { id: string; name: string | null; email: string | null; phone: string | null }[];
};

const displayName = (c: { name: string | null; email: string | null; phone: string | null }) =>
  c.name ?? c.email ?? c.phone ?? 'Unknown';

export function Contacts() {
  const [q, setQ] = useState('');
  const { data } = useQuery({
    queryKey: ['contacts', q],
    queryFn: () => api<{ contacts: ContactRow[] }>(`/api/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
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
      </div>
      <div className="card">
        {data?.contacts.length === 0 && (
          <div className="muted">No contacts yet — they appear as conversations arrive.</div>
        )}
        {data?.contacts.map((c) => (
          <Link key={c.id} to={`/contacts/${c.id}`} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', color: 'inherit', textDecoration: 'none' }}>
            <strong className="grow">{displayName(c)}</strong>
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
  const [edit, setEdit] = useState<{ name: string; email: string; phone: string; notes: string } | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, string | null>) =>
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

  if (!data) return <div className="muted">Loading…</div>;
  const c = data.contact;

  return (
    <>
      <div className="page-head">
        <h1>{displayName(c)}</h1>
        {!edit && <button className="btn" onClick={() => setEdit({ name: c.name ?? '', email: c.email ?? '', phone: c.phone ?? '', notes: c.notes ?? '' })}>Edit</button>}
      </div>

      {edit && (
        <div className="card" style={{ marginBottom: 12 }}>
          <strong>Edit contact</strong>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, maxWidth: 420 }}>
            <input placeholder="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <input placeholder="Email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
            <input placeholder="Phone" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
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
          <div>Phone: {c.phone ?? '—'}</div>
          {c.notes && <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{c.notes}</div>}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <strong>Channel identities</strong>
        {data.identities.length === 0 && <div className="muted" style={{ marginTop: 8 }}>None linked.</div>}
        {data.identities.map((i) => (
          <div key={i.id} className="row" style={{ marginTop: 6 }}>
            <span className="badge">{i.channel_kind}</span>
            <span className="grow">{i.channel_name}</span>
            <span className="mono muted">{i.platform_user_id}</span>
          </div>
        ))}
      </div>

      {data.possible_duplicates.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>Possible duplicates</strong>
          {data.possible_duplicates.map((d) => (
            <div key={d.id} className="row" style={{ marginTop: 6 }}>
              <span className="grow">{displayName(d)}</span>
              <span className="muted">{[d.email, d.phone].filter(Boolean).join(' · ')}</span>
              {isAdmin && (
                <button
                  className="btn"
                  disabled={merge.isPending}
                  onClick={() => {
                    if (confirm(`Merge ${displayName(d)} into ${displayName(c)}? Their conversations and identities move over.`))
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
