import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Message } from '@janis/shared';
import { api } from '../api/client';
import { useConversation, useInvalidateConversations } from '../api/hooks';
import { StateBadge } from '../components/bits';

const WHO: Record<Message['direction'], string> = {
  in: 'User',
  out: 'Agent',
  human: 'Operator',
};

export default function ConversationPage() {
  const { id = '' } = useParams();
  const { data } = useConversation(id);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const qc = useQueryClient();
  const invalidate = useInvalidateConversations();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), [data?.messages.length]);

  const act = useMutation({
    mutationFn: (action: 'takeover' | 'resume' | 'archive') =>
      action === 'archive'
        ? api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ state: 'archived' }) })
        : api(`/api/conversations/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => {
      setError('');
      invalidate();
      void qc.invalidateQueries({ queryKey: ['conversation', id] });
    },
    onError: (e) => setError(e.message),
  });

  const reply = useMutation({
    mutationFn: (text: string) =>
      api(`/api/conversations/${id}/reply`, { method: 'POST', body: JSON.stringify({ text }) }),
    onSuccess: () => {
      setDraft('');
      setError('');
      void qc.invalidateQueries({ queryKey: ['conversation', id] });
    },
    onError: (e) => setError(e.message),
  });

  if (!data) return <div className="muted">Loading…</div>;
  const { conversation: c, messages, alerts } = data;
  const name = (c.user_profile.name as string) ?? c.external_id;

  return (
    <>
      <div className="row">
        <h1 className="page-title grow">{name}</h1>
        <StateBadge state={c.state} />
      </div>

      {alerts.filter((a) => a.status === 'open').length > 0 && (
        <div className="card" style={{ borderColor: 'var(--warn)' }}>
          {alerts.filter((a) => a.status === 'open').map((a) => (
            <div key={a.id} className="muted">
              ⚠ {a.type.replace('_', ' ')}{a.detail ? ` — ${a.detail}` : ''}
            </div>
          ))}
        </div>
      )}

      <div className="transcript">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.direction}`}>
            <div className="who">{WHO[m.direction]}</div>
            {m.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <div className="error">{error}</div>}

      {c.state === 'human' ? (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) reply.mutate(draft.trim());
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Reply to user as a human…"
            autoFocus
          />
          <button className="btn primary" type="submit" disabled={reply.isPending}>Send</button>
          <button className="btn" type="button" onClick={() => act.mutate('resume')}>
            Resume agent
          </button>
        </form>
      ) : (
        <div className="row">
          {c.state !== 'archived' && (
            <>
              <button className="btn primary" onClick={() => act.mutate('takeover')}>
                Take over
              </button>
              <button className="btn danger" onClick={() => act.mutate('archive')}>Archive</button>
            </>
          )}
          {c.state === 'archived' && <span className="muted">Archived</span>}
        </div>
      )}
    </>
  );
}
