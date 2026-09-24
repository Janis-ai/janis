import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Agent } from '@janis/shared';
import { api } from '../api/client';
import { useAgents, useChannels, useMe } from '../api/hooks';
import { timeAgo } from '../components/bits';

export default function Agents() {
  const { data } = useAgents();
  const { data: me } = useMe();
  const isAdmin = me?.user.role === 'admin';
  const { data: channelsData } = useChannels();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [newName, setNewName] = useState('');
  const [newHosted, setNewHosted] = useState(true);
  const [error, setError] = useState('');

  const refresh = () => void qc.invalidateQueries({ queryKey: ['agents'] });

  const create = useMutation({
    mutationFn: ({ name, hosted }: { name: string; hosted: boolean }) =>
      api<{ agent: Agent }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name, hosted }),
      }),
    onSuccess: (r) => {
      setNewName('');
      refresh();
      navigate(`/agents/${r.agent.id}`);
    },
    onError: (e) => setError(e.message),
  });

  const removeAgent = useMutation({
    mutationFn: (id: string) => api(`/api/agents/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  return (
    <>
      <h1 className="page-title">Agents</h1>

      {isAdmin && (
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (newName.trim()) create.mutate({ name: newName.trim(), hosted: newHosted });
        }}
      >
        <input
          className="grow"
          placeholder="New agent name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <select value={newHosted ? 'hosted' : 'external'} onChange={(e) => setNewHosted(e.target.value === 'hosted')}>
          <option value="hosted">Hosted by Janis</option>
          <option value="external">External webhook</option>
        </select>
        <button className="btn primary">Create agent</button>
      </form>
      )}

      {error && <div className="error">{error}</div>}

      <div className="agent-list">
        {data?.agents.map((agent) => {
          const channels = channelsData?.channels.filter((c) => c.agent_id === agent.id) ?? [];
          return (
            <div
              key={agent.id}
              className="card row agent-row"
              style={{ alignItems: 'center', cursor: 'pointer' }}
              onClick={() => navigate(`/agents/${agent.id}`)}
            >
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{agent.name}</div>
                <div className="muted" style={{ marginTop: 2 }}>
                  {agent.hosted ? 'hosted by Janis' : 'external webhook'}
                  {' · '}
                  {agent.last_seen_at ? `last event ${timeAgo(agent.last_seen_at)}` : 'no events yet'}
                  {channels.length > 0 && ` · ${channels.map((c) => c.name).join(', ')}`}
                  {!agent.hosted && !agent.webhook_url && (
                    <div style={{ color: '#fde047', marginTop: 2 }}>
                      Not reachable — no webhook URL and not hosted by Janis. Inbound messages will go unanswered.
                    </div>
                  )}
                </div>
              </div>
              <span className={`badge ${agent.hosted ? 'active' : agent.webhook_url ? '' : 'warn'}`}>
                {agent.hosted ? 'hosted' : agent.webhook_url ? 'external' : 'unreachable'}
              </span>
              {isAdmin && (
                <button
                  className="btn danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete agent "${agent.name}"?`)) removeAgent.mutate(agent.id);
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          );
        })}
        {data && data.agents.length === 0 && (
          <div className="muted">No agents yet — create one above.</div>
        )}
      </div>
    </>
  );
}
