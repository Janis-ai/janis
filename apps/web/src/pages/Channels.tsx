import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Conversation } from '@janis/shared';
import { useConversations, useAgents, useSearch } from '../api/hooks';
import { Empty, StateBadge, timeAgo } from '../components/bits';

const STATES = ['', 'needs_human', 'human', 'active', 'unread', 'starred', 'archived'] as const;

function ConvRow({ c }: { c: Conversation }) {
  return (
    <Link to={`/conversations/${c.id}`} className="conv-row">
      {c.open_alert_count > 0 && <span className="alert-dot" />}
      {c.is_unread && <span className="unread-dot" title="Unread" />}
      <div className="who">
        <div className={`name ${c.is_unread ? 'unread' : ''}`}>
          {c.is_starred && '⭐ '}
          {(c.user_profile?.name as string) ?? c.external_id}
        </div>
        <div className="preview">{c.last_message_preview}</div>
      </div>
      <StateBadge state={c.state} />
      <div className="meta">{timeAgo(c.last_message_at)}</div>
    </Link>
  );
}

/** Channel management: search + browse/filter every conversation. */
export default function Channels() {
  const [state, setState] = useState('');
  const [agentId, setAgentId] = useState('');
  const [query, setQuery] = useState('');
  const { data } = useConversations({
    state: state || undefined,
    agent_id: agentId || undefined,
  });
  const { data: agents } = useAgents();
  const { data: hits } = useSearch(query);

  const searching = query.trim().length > 0;

  return (
    <>
      <h1 className="page-title">Channels</h1>
      <div className="filters">
        <input
          className="search-box"
          placeholder="Search transcripts, users, ids…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {STATES.filter(Boolean).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">All agents</option>
          {agents?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      {searching ? (
        <>
          {hits && hits.conversations.length === 0 && <Empty>No matches.</Empty>}
          {hits?.conversations.map((c) => <ConvRow key={c.id} c={c} />)}
          {hits && hits.messages.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <strong>Message hits</strong>
              {hits.messages.slice(0, 20).map((m) => (
                <div key={m.id} className="muted" style={{ marginTop: 6 }}>
                  <Link to={`/conversations/${m.conversation_id}`}>
                    {m.direction === 'in' ? '👤' : m.direction === 'out' ? '🤖' : '🧑'} {m.text}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {data && data.conversations.length === 0 && <Empty>No conversations.</Empty>}
          {data?.conversations.map((c) => <ConvRow key={c.id} c={c} />)}
        </>
      )}
    </>
  );
}
