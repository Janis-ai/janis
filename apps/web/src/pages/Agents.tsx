import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAgents, useChannels, useMe } from '../api/hooks';
import { timeAgo } from '../components/bits';
import { useConfirm } from '../components/Prompt';
import { useNewAgentDialog } from '../components/NewAgentDialog';
import { friendlyError } from '../lib/friendlyError';
import { usePageTitle } from '../lib/title';

export default function Agents() {
  usePageTitle('Agents');
  const { data } = useAgents();
  const { data: me } = useMe();
  const isAdmin = me?.user.role === 'admin';
  const { data: channelsData } = useChannels();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirmEl, confirm] = useConfirm();
  const [newAgentEl, openNewAgent] = useNewAgentDialog();
  const [error, setError] = useState('');
  // OAuth callbacks that fail before resolving the channel land here.
  const [params] = useSearchParams();
  const oauthError =
    params.get('cf_error') ?? params.get('gmail_error') ?? params.get('outlook_error') ?? '';

  const refresh = () => void qc.invalidateQueries({ queryKey: ['agents'] });

  const removeAgent = useMutation({
    mutationFn: (id: string) => api(`/api/agents/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  return (
    <>
      {confirmEl}
      {newAgentEl}
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 className="page-title grow">Agents</h1>
        {isAdmin && (
          <button className="btn primary" onClick={openNewAgent}>＋ Create agent</button>
        )}
      </div>
      {oauthError && (() => {
        const f = friendlyError(oauthError);
        return <div className="error" title={f.detail}>Connect failed: {f.text}</div>;
      })()}

      {error && <div className="error">{error}</div>}

      <div className="agent-list">
        {[...(data?.agents ?? [])]
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
          .map((agent) => {
          const channels = channelsData?.channels.filter((c) => c.agent_id === agent.id) ?? [];
          return (
            <div
              key={agent.id}
              className="card row agent-row"
              style={{ alignItems: 'center' }}
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
              <button
                className="btn"
                onClick={() => navigate(`/agents/${agent.id}/inbox`)}
              >
                Inbox
              </button>
              <button
                className="btn"
                onClick={() => navigate(`/agents/${agent.id}`)}
              >
                Manage
              </button>
              {isAdmin && (
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (await confirm(`Delete agent "${agent.name}"? Its channels, conversations, and settings are removed.`, [{ key: 'ok', label: 'Delete', danger: true }])) removeAgent.mutate(agent.id);
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          );
        })}
        {data && data.agents.length === 0 && (
          <div className="card" style={{ marginTop: 12, padding: '28px 20px', textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>No agents yet</div>
            <div className="muted" style={{ marginTop: 6, maxWidth: 420, marginLeft: 'auto', marginRight: 'auto' }}>
              An agent answers your customers on a channel — webchat, Messenger, email, voice.
              Create one hosted by Janis to get AI replies with a shared inbox, or point an
              external webhook at your own backend.
            </div>
            {isAdmin && (
              <button className="btn primary" style={{ marginTop: 14 }} onClick={openNewAgent}>
                Create your first agent
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
