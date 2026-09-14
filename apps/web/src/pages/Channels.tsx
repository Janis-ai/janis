import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useConversations, useAgents } from '../api/hooks';
import { Empty, StateBadge, timeAgo } from '../components/bits';

const STATES = ['', 'needs_human', 'human', 'active', 'archived'] as const;

/** Channel management: browse/filter every conversation. */
export default function Channels() {
  const [state, setState] = useState('');
  const [agentId, setAgentId] = useState('');
  const { data } = useConversations({
    state: state || undefined,
    agent_id: agentId || undefined,
  });
  const { data: agents } = useAgents();

  return (
    <>
      <h1 className="page-title">Channels</h1>
      <div className="filters">
        <select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {STATES.filter(Boolean).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">All agents</option>
          {agents?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      {data && data.conversations.length === 0 && <Empty>No conversations.</Empty>}
      {data?.conversations.map((c) => (
        <Link key={c.id} to={`/conversations/${c.id}`} className="conv-row">
          {c.open_alert_count > 0 && <span className="alert-dot" />}
          <div className="who">
            <div className="name">{(c.user_profile.name as string) ?? c.external_id}</div>
            <div className="preview">{c.last_message_preview}</div>
          </div>
          <StateBadge state={c.state} />
          <div className="meta">{timeAgo(c.last_message_at)}</div>
        </Link>
      ))}
    </>
  );
}
