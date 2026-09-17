import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Conversation } from '@janis/shared';
import { useConversations, useAgents, useSearch } from '../api/hooks';
import { Avatar, channelLabel, displayName, Empty, StateBadge, timeAgo } from '../components/bits';
import Onboarding from '../components/Onboarding';

const STATES = ['', 'needs_human', 'human', 'active', 'unread', 'starred', 'archived'] as const;

/** useState persisted to localStorage — filters survive navigation. */
function useSticky<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s !== null ? (JSON.parse(s) as T) : initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (next: T) => {
      setV(next);
      localStorage.setItem(key, JSON.stringify(next));
    },
  ];
}

function ConvRow({ c, agentName }: { c: Conversation; agentName?: string }) {
  return (
    <Link to={`/conversations/${c.id}`} className="conv-row">
      {c.open_alert_count > 0 && <span className="alert-dot" />}
      {c.is_unread && <span className="unread-dot" title="Unread" />}
      <Avatar c={c} size={34} />
      <div className="who">
        <div className={`name ${c.is_unread ? 'unread' : ''}`}>
          {c.is_starred && '⭐ '}
          {displayName(c)}
          {agentName && <span className="agent-tag">{agentName}</span>}
          {c.user_profile?.channel && (
            <span className="channel-tag">{channelLabel(c.user_profile.channel)}</span>
          )}
        </div>
        <div className="preview">{c.last_message_preview}</div>
      </div>
      <StateBadge state={c.state} />
      <div className="meta">{timeAgo(c.last_message_at)}</div>
    </Link>
  );
}

/** Conversations: triage (needs attention) + search/browse of everything. */
export default function Conversations() {
  const [tab, setTab] = useSticky<'attention' | 'all'>('conv.tab', 'all');
  const [state, setState] = useSticky('conv.state', '');
  const [agentId, setAgentId] = useSticky('conv.agent', '');
  const [mine, setMine] = useSticky('conv.mine', false);
  const [query, setQuery] = useSticky('conv.query', '');
  const { data } = useConversations({
    attention: tab === 'attention' || undefined,
    state: state || undefined,
    agent_id: agentId || undefined,
    mine,
  });
  const { data: agents } = useAgents();
  const { data: hits } = useSearch(query);

  const searching = query.trim().length > 0;
  const agentName = (c: Conversation) =>
    agents?.agents.find((a) => a.id === c.agent_id)?.name;

  return (
    <>
      <h1 className="page-title">Conversations</h1>
      <Onboarding />
      <div className="filters">
        <button
          className={`btn ${tab === 'all' ? 'primary' : ''}`}
          onClick={() => setTab('all')}
        >
          All
        </button>
        <button
          className={`btn ${tab === 'attention' ? 'primary' : ''}`}
          onClick={() => setTab('attention')}
        >
          Needs attention
        </button>
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
        <label className="check">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Assigned to me
        </label>
      </div>

      {searching ? (
        <>
          {hits && hits.conversations.length === 0 && <Empty>No matches.</Empty>}
          {hits?.conversations.map((c) => <ConvRow key={c.id} c={c} agentName={agentName(c)} />)}
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
          {data && data.conversations.length === 0 && (
            <Empty>
              {tab === 'attention'
                ? 'No conversations need attention. When an agent fails or asks for help, it lands here.'
                : 'No conversations.'}
            </Empty>
          )}
          {data?.conversations.map((c) => <ConvRow key={c.id} c={c} agentName={agentName(c)} />)}
        </>
      )}
    </>
  );
}
