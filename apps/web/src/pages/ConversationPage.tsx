import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Conversation, Message } from '@janis/shared';
import { api } from '../api/client';
import { useAgents, useConversation, useInvalidateConversations, useMe, useUsers } from '../api/hooks';
import { StateBadge } from '../components/bits';

const WHO: Record<Message['direction'], string> = {
  in: 'User',
  out: 'Agent',
  human: 'Operator',
};

export default function ConversationPage() {
  const { id = '' } = useParams();
  const { data } = useConversation(id);
  const { data: agents } = useAgents();
  const { data: users } = useUsers();
  const { data: me } = useMe();
  const [draft, setDraft] = useState('');
  const [sendAs, setSendAs] = useState<'human' | 'agent'>('human');
  const [error, setError] = useState('');
  const qc = useQueryClient();
  const invalidate = useInvalidateConversations();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), [data?.messages.length]);

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
    mutationFn: (body: { tags?: string[]; assignee_id?: string | null }) =>
      api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  const suggest = useMutation({
    mutationFn: () => api(`/api/conversations/${id}/suggest`, { method: 'POST' }),
    onSuccess: () => { setError(''); void qc.invalidateQueries({ queryKey: ['conversation', id] }); },
    onError: (e) => setError(e.message),
  });

  const suggestionStatus = useMutation({
    mutationFn: ({ sid, status }: { sid: string; status: 'used' | 'dismissed' }) =>
      api(`/api/conversations/${id}/suggestions/${sid}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['conversation', id] }),
  });

  const reply = useMutation({
    mutationFn: (text: string) =>
      api(`/api/conversations/${id}/${sendAs === 'agent' ? 'agent-send' : 'reply'}`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
    onSuccess: () => { setDraft(''); setError(''); void qc.invalidateQueries({ queryKey: ['conversation', id] }); },
    onError: (e) => setError(e.message),
  });

  if (!data) return <div className="muted">Loading…</div>;
  const { conversation: c, messages, alerts, suggestions } = data;
  const name = (c.user_profile.name as string) ?? c.external_id;
  const agent = agents?.agents.find((a) => a.id === c.agent_id);
  const assignee = users?.users.find((u) => u.id === c.assignee_id);
  const openAlerts = alerts.filter((a) => a.status === 'open');
  const canSend = c.state === 'human' || sendAs === 'agent';

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (draft.trim()) reply.mutate(draft.trim());
  };

  return (
    <div className="conv-layout">
      <div className="conv-main">
        <div className="row">
          <h1 className="page-title grow">{name}</h1>
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
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.direction}`}>
              <div className="who">
                {WHO[m.direction]}
                {m.direction === 'out' && m.payload.via === 'operator' ? ' (via operator)' : ''}
              </div>
              {m.text}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {error && <div className="error">{error}</div>}

        {suggestions?.length > 0 && (
          <div className="card suggestion">
            <div className="muted" style={{ marginBottom: 6 }}>
              Suggested ({suggestions[0].source === 'agent' ? 'your agent' : 'AI'})
            </div>
            <div>{suggestions[0].text}</div>
            <div className="row" style={{ marginTop: 10 }}>
              <button
                className="btn primary"
                onClick={() => {
                  setDraft(suggestions[0].text);
                  suggestionStatus.mutate({ sid: suggestions[0].id, status: 'used' });
                }}
              >
                Use
              </button>
              <button
                className="btn"
                onClick={() => suggestionStatus.mutate({ sid: suggestions[0].id, status: 'dismissed' })}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <div className="row" style={{ marginBottom: 10 }}>
          {c.state !== 'archived' && (
            <button className="btn" onClick={() => suggest.mutate()} disabled={suggest.isPending}>
              {suggest.isPending ? 'Thinking…' : '✨ Suggest reply'}
            </button>
          )}
        </div>

        {canSend ? (
          <form className="composer" onSubmit={send}>
            {c.state === 'human' && (
              <select value={sendAs} onChange={(e) => setSendAs(e.target.value as 'human' | 'agent')}>
                <option value="human">as human</option>
                <option value="agent">via agent</option>
              </select>
            )}
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={sendAs === 'agent' ? 'Message the agent will deliver…' : 'Reply to user as a human…'}
              autoFocus
            />
            <button className="btn primary" type="submit" disabled={reply.isPending}>Send</button>
            {c.state === 'human' && (
              <button className="btn" type="button" onClick={() => act.mutate('resume')}>Resume agent</button>
            )}
            {c.state !== 'human' && (
              <button className="btn" type="button" onClick={() => setSendAs('human')}>Cancel</button>
            )}
          </form>
        ) : (
          <div className="row">
            {c.state !== 'archived' && (
              <>
                <button className="btn primary" onClick={() => act.mutate('takeover')}>Take over</button>
                <button className="btn" onClick={() => { setSendAs('agent'); }}>Send via agent</button>
                <button className="btn danger" onClick={() => act.mutate('archive')}>Archive</button>
              </>
            )}
            {c.state === 'archived' && <span className="muted">Archived</span>}
          </div>
        )}
      </div>

      <aside className="conv-side">
        <div className="card">
          <strong>Details</strong>
          <div className="muted" style={{ marginTop: 8 }}>
            <div>Agent: {agent?.name ?? '—'}</div>
            <div>User id: {c.external_id}</div>
            {Object.entries(c.user_profile).map(([k, v]) =>
              k === 'metadata' ? null : (
                <div key={k}>{k}: {String(v)}</div>
              ),
            )}
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
