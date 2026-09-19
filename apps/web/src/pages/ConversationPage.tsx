import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Attachment, Conversation, Message } from '@janis/shared';
import { api, ApiError } from '../api/client';
import { useAgents, useConversation, useInvalidateConversations, useMe, useUsers } from '../api/hooks';
import { Avatar, channelLabel, displayName, StateBadge } from '../components/bits';
import Composer from '../components/Composer';

const WHO: Record<Message['direction'], string> = {
  in: 'Customer',
  out: 'Agent',
  human: 'Operator',
};

export default function ConversationPage() {
  const { id = '' } = useParams();
  const { data, error: loadError } = useConversation(id);
  const { data: agents } = useAgents();
  const { data: users } = useUsers();
  const { data: me } = useMe();
  const [draft, setDraft] = useState('');
  const [sendAs, setSendAs] = useState<'human' | 'agent'>('human');
  const [error, setError] = useState('');
  const qc = useQueryClient();
  const invalidate = useInvalidateConversations();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.messages.length]);

  const refresh = () => {
    invalidate();
    void qc.invalidateQueries({ queryKey: ['conversation', id] });
  };

  const act = useMutation({
    mutationFn: (action: 'takeover' | 'resume' | 'archive') =>
      action === 'archive'
        ? api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ state: 'archived' }) })
        : api(`/api/conversations/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => { setError(''); refresh(); },
    onError: (e) => setError(e.message),
  });

  const patch = useMutation({
    mutationFn: (body: {
      tags?: string[];
      assignee_id?: string | null;
      is_starred?: boolean;
      is_unread?: boolean;
    }) =>
      api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (_d, body) => {
      // Viewing a conversation auto-marks it read server-side on every
      // fetch — refetching after "mark unread" would instantly undo it.
      // Patch the cache instead; the list still invalidates for the dot.
      if (body.is_unread !== undefined) {
        qc.setQueryData(
          ['conversation', id],
          (old: { conversation?: { is_unread?: boolean } } | undefined) =>
            old?.conversation
              ? { ...old, conversation: { ...old.conversation, is_unread: body.is_unread } }
              : old,
        );
        invalidate();
      } else {
        refresh();
      }
    },
    onError: (e) => setError(e.message),
  });

  // Opening a conversation marks it read — once per open, so the
  // "Mark unread" toggle can't be undone by a later refetch.
  const markedReadFor = useRef('');
  useEffect(() => {
    if (data?.conversation.is_unread && markedReadFor.current !== id) {
      markedReadFor.current = id;
      patch.mutate({ is_unread: false });
    }
  }, [data?.conversation.is_unread, id]);

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      api(`/api/conversations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: archived ? 'archived' : 'active' }),
      }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  const [suggestOpen, setSuggestOpen] = useState(false);

  const suggest = useMutation({
    mutationFn: () => api(`/api/conversations/${id}/suggest`, { method: 'POST' }),
    onSuccess: () => { setError(''); void qc.invalidateQueries({ queryKey: ['conversation', id] }); },
    onError: (e) => { setError(e.message); setSuggestOpen(false); },
  });

  const askSuggestion = () => {
    setSuggestOpen(true);
    suggest.mutate();
  };

  // Dismiss EVERY pending suggestion — otherwise the next one in the queue
  // slides into the card and it feels like dismiss loads another iteration.
  const dismissSuggestions = async () => {
    const pending = data?.suggestions ?? [];
    await Promise.all(
      pending.map((s) =>
        api(`/api/conversations/${id}/suggestions/${s.id}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'dismissed' }),
        }).catch(() => {}),
      ),
    );
    void qc.invalidateQueries({ queryKey: ['conversation', id] });
  };

  const suggestionStatus = useMutation({
    mutationFn: ({ sid, status }: { sid: string; status: 'used' | 'dismissed' }) =>
      api(`/api/conversations/${id}/suggestions/${sid}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['conversation', id] }),
  });

  const reply = useMutation({
    mutationFn: ({ text, attachments }: { text: string; attachments: Attachment[] }) =>
      api(`/api/conversations/${id}/${sendAs === 'agent' ? 'agent-send' : 'reply'}`, {
        method: 'POST',
        body: JSON.stringify({ text, attachments }),
      }),
    onSuccess: () => { setDraft(''); setError(''); void qc.invalidateQueries({ queryKey: ['conversation', id] }); },
    onError: (e) => setError(e.message),
  });

  if (loadError instanceof ApiError && loadError.status === 404) {
    return (
      <div className="muted">
        Conversation not found. <Link to="/conversations">Back to conversations</Link>
      </div>
    );
  }
  if (!data) return <div className="muted">Loading…</div>;
  const { conversation: c, messages, alerts, suggestions } = data;
  const p = c.user_profile ?? {};
  const name = displayName(c);
  const KNOWN = new Set([
    'id', 'name', 'first_name', 'last_name', 'username', 'email', 'phone',
    'channel', 'channel_name', 'profile_fetched_at', 'metadata',
  ]);
  const extraProfile = Object.entries(p).filter(([k]) => !KNOWN.has(k));
  const agent = agents?.agents.find((a) => a.id === c.agent_id);
  const assignee = users?.users.find((u) => u.id === c.assignee_id);
  const openAlerts = alerts.filter((a) => a.status === 'open');
  const canSend = c.state === 'human' || sendAs === 'agent';

  const send = (attachments: Attachment[]) => {
    reply.mutate({ text: draft, attachments });
  };

  return (
    <div className="conv-layout">
      <div className="conv-main">
        <div className="row">
          <h1 className="page-title grow">{name}</h1>
          <button
            className="btn icon"
            title={c.is_starred ? 'Unstar' : 'Star'}
            onClick={() => patch.mutate({ is_starred: !c.is_starred })}
          >
            {c.is_starred ? '⭐' : '☆'}
          </button>
          <button
            className="btn"
            onClick={() => patch.mutate({ is_unread: !c.is_unread })}
            title={c.is_unread ? 'Mark as read' : 'Mark unread'}
          >
            {c.is_unread ? 'Mark as read' : 'Mark unread'}
          </button>
          <StateBadge state={c.state} />
        </div>

        {openAlerts.length > 0 && (
          <div className="card" style={{ borderColor: 'var(--warn)' }}>
            {openAlerts.map((a) => (
              <div key={a.id} className="muted">
                ⚠ {a.type.replace('_', ' ')}{a.detail ? ` — ${a.detail}` : ''}
              </div>
            ))}
          </div>
        )}

        <div className="transcript">
          {messages.map((m) => {
            const isSystem = m.flags.failure || m.flags.help_requested || m.flags.custom_alert;
            const who =
              m.direction === 'in'
                ? c.user_profile.name ?? WHO.in
                : m.direction === 'out'
                  ? agent?.name ?? WHO.out
                  : users?.users.find((u) => u.id === m.author)?.name ?? WHO.human;
            return (
            <div key={m.id} className={`msg ${isSystem ? 'system' : m.direction}`}>
              {!isSystem && (
                <div className="who">
                  {who}
                  {m.direction === 'out' && m.payload.via === 'operator' ? ' (via operator)' : ''}
                </div>
              )}
              {m.text}
              {m.flags.help_requested && m.payload.summary ? (
                <div className="muted" style={{ marginTop: 4 }}>
                  {String(m.payload.summary)}
                </div>
              ) : null}
              {(m.payload.attachments as Attachment[] | undefined)?.map((a, i) => (
                <div key={i}>
                  {a.type.startsWith('image/') ? (
                    <a href={a.url} target="_blank" rel="noreferrer">
                      <img src={a.url} alt={a.name} style={{ maxWidth: 220, borderRadius: 8, marginTop: 6 }} />
                    </a>
                  ) : (
                    <a href={a.url} target="_blank" rel="noreferrer" className="attach-chip">
                      📎 {a.name}
                    </a>
                  )}
                </div>
              ))}
            </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {error && <div className="error">{error}</div>}

        {canSend && (suggestOpen || suggestions?.length > 0) && (
          <div className="card suggestion">
            {suggestions?.length > 0 ? (
              <>
                <div className="muted" style={{ marginBottom: 6 }}>
                  Suggested ({suggestions[0].source === 'agent' ? 'your agent' : 'AI'})
                </div>
                <div>{suggestions[0].text}</div>
              </>
            ) : (
              <div className="muted">Thinking…</div>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <button
                className="btn primary"
                disabled={!(suggestions?.length > 0)}
                onClick={() => {
                  setDraft(suggestions[0].text);
                  suggestionStatus.mutate({ sid: suggestions[0].id, status: 'used' });
                  setSuggestOpen(false);
                }}
              >
                Use
              </button>
              <button
                className="btn icon"
                title="Try another suggestion"
                disabled={suggest.isPending}
                onClick={() => { void dismissSuggestions(); suggest.mutate(); }}
              >
                ↻
              </button>
              <button
                className="btn"
                onClick={() => { setSuggestOpen(false); void dismissSuggestions(); }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {canSend && !suggestOpen && !(suggestions?.length > 0) && (
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="btn" onClick={askSuggestion} disabled={suggest.isPending}>
              ✨ Suggest reply
            </button>
          </div>
        )}

        {canSend ? (
          <>
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={send}
              onResume={c.state === 'human' ? () => act.mutate('resume') : undefined}
              sendAs={sendAs}
              setSendAs={setSendAs}
              showModeSelect={c.state === 'human'}
              sending={reply.isPending}
            />
            {c.state !== 'human' && (
              <button className="btn" style={{ marginTop: 8 }} onClick={() => setSendAs('human')}>Cancel</button>
            )}
          </>
        ) : (
          <div className="row">
            {c.state !== 'archived' && (
              <>
                <button className="btn primary" onClick={() => act.mutate('takeover')}>Take over</button>
                <button className="btn" onClick={() => { setSendAs('agent'); }}>Send via agent</button>
                <button className="btn danger" onClick={() => act.mutate('archive')}>Archive</button>
              </>
            )}
            {c.state === 'archived' && (
              <>
                <span className="muted">Archived</span>
                <button className="btn" disabled={archive.isPending} onClick={() => archive.mutate(false)}>
                  {archive.isPending ? 'Working…' : 'Unarchive'}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <aside className="conv-side">
        <div className="card">
          <strong>Details</strong>
          <div className="profile-head">
            <Avatar c={c} size={44} />
            <div>
              <div className="profile-name">{name}</div>
              {p.username && !name.startsWith('@') && (
                <div className="muted">@{p.username}</div>
              )}
            </div>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            {(p.channel || p.channel_name) && (
              <div>
                Channel: {channelLabel(p.channel)}
                {p.channel_name ? ` · ${p.channel_name}` : ''}
              </div>
            )}
            <div>Email: {p.email ?? '—'}</div>
            {p.phone && <div>Phone: {p.phone}</div>}
            <div>User id: {p.id ?? c.external_id}</div>
            <div>Agent: {agent?.name ?? '—'}</div>
            {extraProfile.map(([k, v]) => (
              <div key={k}>{k}: {String(v)}</div>
            ))}
            <div>Assigned: {assignee?.name ?? 'unassigned'}</div>
            {c.human_since && <div>Human since: {new Date(c.human_since).toLocaleTimeString()}</div>}
            {agent?.auto_resume_minutes && (
              <div>Auto-resume after {agent.auto_resume_minutes}m</div>
            )}
          </div>
        </div>

        <div className="card">
          <strong>Assign to</strong>
          <select
            style={{ width: '100%', marginTop: 8 }}
            value={c.assignee_id ?? ''}
            onChange={(e) => patch.mutate({ assignee_id: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {users?.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}{u.id === me?.user.id ? ' (me)' : ''}
              </option>
            ))}
          </select>
        </div>

        <TagEditor conversation={c} onSave={(tags) => patch.mutate({ tags })} />

      </aside>
    </div>
  );
}

function TagEditor({
  conversation,
  onSave,
}: {
  conversation: Conversation;
  onSave: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  return (
    <div className="card">
      <strong>Tags</strong>
      <div style={{ marginTop: 8 }}>
        {conversation.tags.map((t) => (
          <span key={t} className="badge active" style={{ marginRight: 6 }}>
            {t}{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onSave(conversation.tags.filter((x) => x !== t));
              }}
            >
              ✕
            </a>
          </span>
        ))}
      </div>
      <form
        className="row"
        style={{ marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          const tag = draft.trim();
          if (tag && !conversation.tags.includes(tag)) {
            onSave([...conversation.tags, tag]);
          }
          setDraft('');
        }}
      >
        <input className="grow" placeholder="add tag" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn">+</button>
      </form>
    </div>
  );
}
