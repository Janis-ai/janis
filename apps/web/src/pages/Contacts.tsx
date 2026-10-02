import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { timeAgo } from '../components/bits';
import { useConfirm } from '../components/Prompt';
import { AgentScopePicker } from '../components/AgentScopePicker';
import { useChannels, useMe } from '../api/hooks';
import { useContextAgent } from '../lib/agentContext';
import { usePageTitle } from '../lib/title';

/** Filter state for the People tab — mirrors the segment rules the API
 *  (and a smart list's saved `filter`) understands. */
type ContactFilter = {
  tag: string;
  agent_id: string;
  channel_id: string;
  list_id: string;
  has_email: boolean;
  has_phone: boolean;
  active_within_days: string;
  never_replied: boolean;
};
const EMPTY_FILTER: ContactFilter = {
  tag: '',
  agent_id: '',
  channel_id: '',
  list_id: '',
  has_email: false,
  has_phone: false,
  active_within_days: '',
  never_replied: false,
};

function filterParams(q: string, f: ContactFilter): string {
  const p = new URLSearchParams();
  if (q.trim()) p.set('q', q.trim());
  if (f.tag.trim()) p.set('tag', f.tag.trim());
  if (f.agent_id) p.set('agent_id', f.agent_id);
  if (f.channel_id) p.set('channel_id', f.channel_id);
  if (f.list_id) p.set('list_id', f.list_id);
  if (f.has_email) p.set('has_email', '1');
  if (f.has_phone) p.set('has_phone', '1');
  if (f.active_within_days) p.set('active_within_days', f.active_within_days);
  if (f.never_replied) p.set('never_replied', '1');
  return p.toString();
}

/** Same state as a saved-filter object for POST /api/lists. */
function filterObject(q: string, f: ContactFilter, agentScope?: string) {
  return {
    q: q.trim() || undefined,
    tags: f.tag.trim() ? f.tag.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
    agent_id: agentScope || f.agent_id || undefined,
    channel_id: f.channel_id || undefined,
    list_id: f.list_id || undefined,
    has_email: f.has_email || undefined,
    has_phone: f.has_phone || undefined,
    active_within_days: f.active_within_days ? parseInt(f.active_within_days, 10) : undefined,
    never_replied: f.never_replied || undefined,
  };
}

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

export function Contacts({ agentId: routeAgent }: { agentId?: string } = {}) {
  usePageTitle('Contacts');
  // Agent scoping comes from app context (URL agent or the persisted pick),
  // not a local filter — the picker in the header is the context control.
  const ctxAgent = useContextAgent();
  const agentId = routeAgent ?? ctxAgent ?? undefined;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<ContactFilter>(EMPTY_FILTER);
  const [showFilters, setShowFilters] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [tab, setTab] = useState<'contacts' | 'lists'>('contacts');
  const { data: me } = useMe();
  const isAdmin = me?.user.role === 'admin';
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState('');
  const baseParams = filterParams(q, filter);
  // Context scoping pins the identity graph to contacts this agent has
  // actually seen (scoped route or persisted context agent).
  const params = agentId ? `${baseParams}${baseParams ? '&' : ''}agent_id=${agentId}` : baseParams;
  const filtered = JSON.stringify(filter) !== JSON.stringify(EMPTY_FILTER);
  const { data } = useQuery({
    queryKey: ['contacts', params],
    queryFn: () => api<{ contacts: ContactRow[] }>(`/api/contacts${params ? `?${params}` : ''}`),
  });
  const saveList = useMutation({
    mutationFn: (body: { name: string; filter: ReturnType<typeof filterObject>; snapshot: boolean }) =>
      api('/api/lists', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setSaveOpen(false);
      void qc.invalidateQueries({ queryKey: ['lists'] });
    },
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
        <AgentScopePicker slug="contacts" value={agentId} />
        <div className="row" style={{ gap: 0 }}>
          <button
            className={`btn ${tab === 'contacts' ? 'primary' : 'ghost'}`}
            onClick={() => setTab('contacts')}
          >
            People
          </button>
          <button
            className={`btn ${tab === 'lists' ? 'primary' : 'ghost'}`}
            onClick={() => setTab('lists')}
          >
            Lists
          </button>
        </div>
        {tab === 'contacts' && (
          <input
            className="grow"
            style={{ maxWidth: 320 }}
            placeholder="Search name, email, phone…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        )}
        {tab === 'contacts' && (
          <button
            className={`btn ${showFilters || filtered ? 'primary' : 'ghost'}`}
            onClick={() => setShowFilters(!showFilters)}
          >
            Filters{filtered ? ' •' : ''}
          </button>
        )}
        {isAdmin && tab === 'contacts' && (filtered || q.trim()) && (
          <button className="btn" onClick={() => setSaveOpen(!saveOpen)}>
            Save as list
          </button>
        )}
        {isAdmin && tab === 'contacts' && (
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
      {tab === 'contacts' && showFilters && (
        <FilterBar filter={filter} onChange={setFilter} onClear={() => setFilter(EMPTY_FILTER)} agentScope={agentId} />
      )}
      {tab === 'contacts' && saveOpen && (
        <SaveListPanel
          filter={filterObject(q, filter, agentId)}
          isPending={saveList.isPending}
          onSave={(name, snapshot) => saveList.mutate({ name, filter: filterObject(q, filter, agentId), snapshot })}
          onClose={() => setSaveOpen(false)}
        />
      )}
      {tab === 'lists' && <ListsPanel isAdmin={isAdmin} agentScope={agentId} />}
      {tab === 'contacts' && (
      <div className="card">
        {data?.contacts.length === 0 && (
          <div className="muted">No contacts yet — they appear as conversations arrive.</div>
        )}
        {data?.contacts.map((c) => (
          <Link key={c.id} to={agentId ? `/agents/${agentId}/contacts/${c.id}` : `/contacts/${c.id}`} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', color: 'inherit', textDecoration: 'none' }}>
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
      )}
    </>
  );
}

/** Property filters over the people list — same rule fields a smart list
 *  stores, so "save this filter" round-trips losslessly. */
function FilterBar({
  filter: f,
  onChange,
  onClear,
  agentScope,
}: {
  filter: ContactFilter;
  onChange: (f: ContactFilter) => void;
  onClear: () => void;
  /** Set when the page is already pinned to an agent (/agents/:id/contacts)
   *  — the picker is redundant there, so only channels narrow further. */
  agentScope?: string;
}) {
  const { data: chans } = useChannels();
  const { data: listsData } = useQuery({
    queryKey: ['lists'],
    queryFn: () => api<{ lists: ListRow[] }>('/api/lists'),
  });
  const set = (patch: Partial<ContactFilter>) => onChange({ ...f, ...patch });
  const channelOptions = (chans?.channels ?? []).filter(
    (ch) => !(agentScope || f.agent_id) || ch.agent_id === (agentScope || f.agent_id),
  );
  return (
    <div className="card row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <input
        style={{ maxWidth: 140 }}
        placeholder="Tag"
        value={f.tag}
        onChange={(e) => set({ tag: e.target.value })}
      />
      <select className="input" value={f.channel_id} onChange={(e) => set({ channel_id: e.target.value })}>
        <option value="">Any channel</option>
        {channelOptions.map((ch) => (
          <option key={ch.id} value={ch.id}>{ch.name}</option>
        ))}
      </select>
      <select className="input" value={f.list_id} onChange={(e) => set({ list_id: e.target.value })}>
        <option value="">Any list</option>
        {(listsData?.lists ?? []).map((l) => (
          <option key={l.id} value={l.id}>{l.name}{l.smart ? ' (smart)' : ''}</option>
        ))}
      </select>
      <label className="muted" style={{ fontSize: 13 }}>
        <input type="checkbox" checked={f.has_email} onChange={(e) => set({ has_email: e.target.checked })} /> has email
      </label>
      <label className="muted" style={{ fontSize: 13 }}>
        <input type="checkbox" checked={f.has_phone} onChange={(e) => set({ has_phone: e.target.checked })} /> has phone
      </label>
      <label className="muted" style={{ fontSize: 13 }}>
        active within{' '}
        <input
          type="number"
          min={1}
          style={{ width: 60 }}
          placeholder="—"
          value={f.active_within_days}
          onChange={(e) => set({ active_within_days: e.target.value })}
        />{' '}
        days
      </label>
      <label className="muted" style={{ fontSize: 13 }}>
        <input type="checkbox" checked={f.never_replied} onChange={(e) => set({ never_replied: e.target.checked })} /> never replied
      </label>
      <button className="btn ghost" onClick={onClear}>Clear</button>
    </div>
  );
}

/** Save the current search+filters as either a live smart list or a
 *  frozen snapshot of the matching contacts. */
function SaveListPanel({
  filter,
  isPending,
  onSave,
  onClose,
}: {
  filter: ReturnType<typeof filterObject>;
  isPending: boolean;
  onSave: (name: string, snapshot: boolean) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'smart' | 'snapshot'>('smart');
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <strong>Save as list</strong>
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
        <input
          style={{ maxWidth: 220 }}
          placeholder="List name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="muted" style={{ fontSize: 13 }}>
          <input type="radio" checked={kind === 'smart'} onChange={() => setKind('smart')} /> smart — updates itself as contacts change
        </label>
        <label className="muted" style={{ fontSize: 13 }}>
          <input type="radio" checked={kind === 'snapshot'} onChange={() => setKind('snapshot')} /> snapshot — freeze today's matches
        </label>
        <button className="btn primary" disabled={isPending || !name.trim()} onClick={() => onSave(name.trim(), kind === 'snapshot')}>
          Save
        </button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
      <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
        Rules: {summariseFilter(filter) || 'all contacts'}
      </div>
    </div>
  );
}

function summariseFilter(f: ReturnType<typeof filterObject>): string {
  const bits: string[] = [];
  if (f.q) bits.push(`matching "${f.q}"`);
  if (f.tags?.length) bits.push(`tagged ${f.tags.join(' or ')}`);
  if (f.agent_id) bits.push('belongs to an agent');
  if (f.channel_id) bits.push('on the chosen channel');
  if (f.list_id) bits.push('in the chosen list');
  if (f.has_email) bits.push('has email');
  if (f.has_phone) bits.push('has phone');
  if (f.active_within_days) bits.push(`active in ${f.active_within_days}d`);
  if (f.never_replied) bits.push('never replied');
  return bits.join(' · ');
}

type ListRow = { id: string; name: string; members: number; smart?: boolean; filter?: Record<string, unknown>; created_at: string };
type MemberRow = { id: string; name: string | null; email: string | null; phone: string | null; tags?: string[] };

/** Static audiences — create/rename/delete lists, view + edit membership.
 *  Membership feeds campaign segments (list_id) and CSV imports. */
function ListsPanel({ isAdmin, agentScope }: { isAdmin: boolean; agentScope?: string }) {
  const [confirmEl, confirm] = useConfirm();
  const qc = useQueryClient();
  const [newName, setNewName] = useState('');
  const [openId, setOpenId] = useState('');
  const { data } = useQuery({
    queryKey: ['lists'],
    queryFn: () => api<{ lists: ListRow[] }>('/api/lists'),
  });
  const create = useMutation({
    mutationFn: () => api('/api/lists', { method: 'POST', body: JSON.stringify({ name: newName }) }),
    onSuccess: () => {
      setNewName('');
      void qc.invalidateQueries({ queryKey: ['lists'] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/lists/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['lists'] }),
  });
  return (
    <div className="card">
      {confirmEl}
      {isAdmin && (
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            className="grow"
            style={{ maxWidth: 240 }}
            placeholder="New list name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && newName.trim() && create.mutate()}
          />
          <button className="btn" disabled={create.isPending || !newName.trim()} onClick={() => create.mutate()}>
            Create list
          </button>
          <span className="muted" style={{ fontSize: 13 }}>or use Import CSV above — each file becomes a list.</span>
        </div>
      )}
      {data?.lists.length === 0 && (
        <div className="muted">No lists yet — import a CSV or create one.</div>
      )}
      {data?.lists.map((l) => (
        <div key={l.id} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
          <div className="row">
            <button className="btn ghost grow" style={{ textAlign: 'left' }} onClick={() => setOpenId(openId === l.id ? '' : l.id)}>
              <strong>{l.name}</strong>
              {l.smart && <span className="chip" style={{ marginLeft: 8 }}>smart</span>}
            </button>
            <span className="muted">{l.members} member{l.members === 1 ? '' : 's'}{l.smart ? ' now' : ''}</span>
            {isAdmin && (
              <button
                className="btn danger"
                onClick={async () => {
                  if (await confirm(`Delete list "${l.name}"? Contacts stay — only the grouping is removed.`, undefined, true)) del.mutate(l.id);
                }}
              >
                Delete
              </button>
            )}
          </div>
          {l.smart && (
            <div className="muted" style={{ fontSize: 13 }}>
              {summariseFilter(l.filter as ReturnType<typeof filterObject>)} — membership updates itself
            </div>
          )}
          {openId === l.id && <ListMembers listId={l.id} isAdmin={isAdmin && !l.smart} agentScope={agentScope} />}
        </div>
      ))}
    </div>
  );
}

function ListMembers({ listId, isAdmin, agentScope }: { listId: string; isAdmin: boolean; agentScope?: string }) {
  const qc = useQueryClient();
  const [addQ, setAddQ] = useState('');
  const { data } = useQuery({
    queryKey: ['list-members', listId],
    queryFn: () => api<{ members: MemberRow[] }>(`/api/lists/${listId}/members`),
  });
  const search = useQuery({
    queryKey: ['contacts', `list-add:${listId}:${addQ}`],
    enabled: addQ.trim().length > 1,
    queryFn: () => api<{ contacts: ContactRow[] }>(`/api/contacts?q=${encodeURIComponent(addQ)}`),
  });
  const memberIds = new Set((data?.members ?? []).map((m) => m.id));
  const candidates = (search.data?.contacts ?? []).filter((c) => !memberIds.has(c.id)).slice(0, 8);
  const add = useMutation({
    mutationFn: (contactId: string) =>
      api(`/api/lists/${listId}/members`, { method: 'POST', body: JSON.stringify({ contact_id: contactId }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['list-members', listId] }),
  });
  const remove = useMutation({
    mutationFn: (contactId: string) =>
      api(`/api/lists/${listId}/members/${contactId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['list-members', listId] }),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['list-members', listId] });
    void qc.invalidateQueries({ queryKey: ['lists'] });
  };
  return (
    <div style={{ marginTop: 8 }}>
      {isAdmin && (
        <div style={{ marginBottom: 8 }}>
          <input
            className="grow"
            style={{ maxWidth: 280 }}
            placeholder="Add a contact — search name, email, phone…"
            value={addQ}
            onChange={(e) => setAddQ(e.target.value)}
          />
          {candidates.map((c) => (
            <div key={c.id} className="row" style={{ padding: '4px 0' }}>
              <span className="grow">{displayName(c)} <span className="muted">{[c.email, c.phone].filter(Boolean).join(' · ')}</span></span>
              <button className="btn" onClick={() => add.mutate(c.id)}>Add</button>
            </div>
          ))}
        </div>
      )}
      {(data?.members ?? []).map((m) => (
        <div key={m.id} className="row" style={{ padding: '4px 0' }}>
          <Link to={agentScope ? `/agents/${agentScope}/contacts/${m.id}` : `/contacts/${m.id}`} className="grow" style={{ color: 'inherit', textDecoration: 'none' }}>
            {displayName(m)} <span className="muted">{[m.email, m.phone].filter(Boolean).join(' · ')}</span>
          </Link>
          {isAdmin && (
            <button className="btn ghost" onClick={() => { remove.mutate(m.id); invalidate(); }}>
              Remove
            </button>
          )}
        </div>
      ))}
      {!!data && !data.members.length && (
        <div className="muted">{isAdmin ? 'Empty — search above to add contacts.' : 'No contacts match the rules right now.'}</div>
      )}
    </div>
  );
}

export function ContactDetail() {
  // /agents/:agentId/contacts/:cid nests under agent context — :id is the
  // agent there; the flat /contacts/:id route carries the contact in :id.
  const params = useParams();
  const id = params.cid ?? params.id;
  const agentScope = params.cid ? params.id : undefined;
  const qc = useQueryClient();
  const { data: me } = useMe();
  const isAdmin = me?.user.role === 'admin';
  const { data } = useQuery({
    queryKey: ['contact', id],
    queryFn: () => api<ContactDetail>(`/api/contacts/${id}`),
    enabled: !!id,
  });
  usePageTitle(data ? displayName(data.contact) : 'Contact');
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
  const [confirmEl, confirm] = useConfirm();
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
      {confirmEl}
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
              onClick={async () => {
                const choice = await confirm(
                  `Delete ${displayName(c)}? Channel identities are removed. Purge also deletes every conversation and transcript for this person; delete-only keeps anonymized transcripts.`,
                  [
                    { key: 'delete', label: 'Delete contact only' },
                    { key: 'purge', label: 'Purge all data', danger: true },
                  ],
                );
                if (choice === 'purge') del.mutate(true);
                else if (choice === 'delete') del.mutate(false);
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
          <IdentityRow key={i.id} identity={i} contactId={id!} agentScope={agentScope} />
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
                  onClick={async () => {
                    if (await confirm(`Merge ${displayName(d)} (${[d.email, d.phone].filter(Boolean).join(', ') || 'no contact info'}) into ${displayName(c)} (${[c.email, c.phone].filter(Boolean).join(', ') || 'no contact info'})? Their conversations, identities, and any differing email/phone move over.`))
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
          <Link key={v.id} to={agentScope ? `/agents/${agentScope}/inbox/${v.id}` : `/conversations/${v.id}`} className="row" style={{ padding: '6px 0', color: 'inherit', textDecoration: 'none' }}>
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
  agentScope,
}: {
  identity: { id: string; platform_user_id: string; channel_id: string; channel_kind: string; channel_name: string };
  contactId: string;
  /** Agent context the page is nested under — outbound sends land back in
   *  that agent's inbox rather than dropping to the workspace queue. */
  agentScope?: string;
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
      if (r.conversation_id) navigate(agentScope ? `/agents/${agentScope}/inbox/${r.conversation_id}` : `/conversations/${r.conversation_id}`);
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
