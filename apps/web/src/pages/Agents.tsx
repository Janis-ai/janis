import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Gauge, Inbox, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { useAgents, useChannels, useMe } from '../api/hooks';
import { timeAgo } from '../components/bits';
import { useConfirm } from '../components/Prompt';
import { friendlyError } from '../lib/friendlyError';
import { usePageTitle } from '../lib/title';
import { KIND_LABEL } from '../components/Channels';

export default function Agents() {
  usePageTitle('Agents');
  const { data } = useAgents();
  const { data: me } = useMe();
  const isAdmin = me?.user.role === 'admin';
  const { data: channelsData } = useChannels();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirmEl, confirm] = useConfirm();
  const [error, setError] = useState('');
  // OAuth callbacks that fail before resolving the channel land here.
  const [params] = useSearchParams();
  const oauthError =
    params.get('cf_error') ?? params.get('gmail_error') ?? params.get('outlook_error') ?? '';

  const refresh = () => void qc.invalidateQueries({ queryKey: ['agents'] });

  // Per-row layout, same as the overview head: buttons pin top-right;
  // the name scales down (floor 13) to avoid overlap, then the name-line
  // ellipsis truncates. Measured per row via one ResizeObserver.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const range = document.createRange();
    const check = () => {
      el.querySelectorAll<HTMLElement>('.agent-row').forEach((row) => {
        const main = row.querySelector<HTMLElement>('.agent-main');
        const t = row.querySelector<HTMLElement>('.agent-name');
        const line = row.querySelector<HTMLElement>('.agent-name-line');
        const a = row.querySelector<HTMLElement>('.agent-actions');
        if (!main || !t || !line || !a) return;
        t.style.fontSize = '';
        // clientWidth of the padded main feeds back into itself — measure
        // the row and subtract card padding + the actions column.
        const cs = getComputedStyle(row);
        const avail = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - a.offsetWidth - 10;
        const base = parseFloat(getComputedStyle(t).fontSize);
        range.selectNodeContents(t);
        const need = range.getBoundingClientRect().width;
        if (need > avail) {
          t.style.fontSize = `${Math.max(13, Math.min(base, Math.floor((base * avail) / need)))}px`;
        }
        line.style.maxWidth = `${avail}px`;
        main.style.paddingRight = `${a.offsetWidth + 12}px`;
      });
    };
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  }, [data?.agents.length, channelsData?.channels.length]);

  const removeAgent = useMutation({
    mutationFn: (id: string) => api(`/api/agents/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  return (
    <>
      {confirmEl}
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 className="page-title grow">Agents</h1>
        {isAdmin && (
          <button className="btn primary" onClick={() => navigate('/agents/new')}>＋ Create agent</button>
        )}
      </div>
      {oauthError && (() => {
        const f = friendlyError(oauthError);
        return <div className="error" title={f.detail}>Connect failed: {f.text}</div>;
      })()}

      {error && <div className="error">{error}</div>}

      <div className="agent-list" ref={listRef}>
        {[...(data?.agents ?? [])]
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
          .map((agent) => {
          const channels = channelsData?.channels.filter((c) => c.agent_id === agent.id) ?? [];
          const engine = (agent.config as { engine?: string } | undefined)?.engine;
          const migrated = !!agent.metadata?.migrated_from;
          return (
            <div
              key={agent.id}
              className="card row agent-row"
              style={{ alignItems: 'center' }}
            >
              <div className="grow agent-main" style={{ minWidth: 0 }}>
                <div className="agent-name-line" style={{ fontWeight: 700 }}>
                  <span className="agent-name">{agent.name}</span>
                  {migrated && (
                    <span className="badge" style={{ marginLeft: 8, verticalAlign: 'middle' }}>
                      migrated
                    </span>
                  )}
                  {(engine === 'monitor' || (!agent.hosted && !agent.webhook_url && engine !== 'dialogflow')) && (
                    <span className="badge warn" style={{ marginLeft: 8, verticalAlign: 'middle' }}>
                      {engine === 'monitor' ? 'monitor' : 'unreachable'}
                    </span>
                  )}
                </div>
                <div className="muted" style={{ marginTop: 2 }}>
                  {engine === 'dialogflow' ? 'dialogflow engine · ' : engine === 'monitor' ? 'monitor only · ' : ''}
                  {agent.last_seen_at ? `last event ${timeAgo(agent.last_seen_at)}` : 'no events yet'}
                  {channels.length > 0 && ` · ${[...new Set(channels.map((c) => KIND_LABEL[c.kind] ?? c.name))].join(', ')}`}
                  {!agent.hosted && !agent.webhook_url && (
                    <div style={{ color: '#fde047', marginTop: 2 }}>
                      Not reachable — no webhook URL and not hosted by Janis. Inbound messages will go unanswered.
                    </div>
                  )}
                </div>
              </div>
              <div className="agent-actions">
              <button
                className="btn"
                title="Inbox"
                aria-label={`${agent.name} inbox`}
                onClick={() => navigate(`/agents/${agent.id}/inbox`)}
              >
                <Inbox size={14} />
              </button>
              <button
                className="btn"
                title="Manage"
                aria-label={`Manage ${agent.name}`}
                onClick={() => navigate(`/agents/${agent.id}`)}
              >
                <Gauge size={14} />
              </button>
              {isAdmin && (
                <button
                  className="btn danger"
                  title="Delete"
                  aria-label={`Delete ${agent.name}`}
                  onClick={async () => {
                    if (await confirm(`Delete agent "${agent.name}"? Its channels, conversations, and settings are removed.`, [{ key: 'ok', label: 'Delete', danger: true }])) removeAgent.mutate(agent.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
              </div>
            </div>
          );
        })}
        {data && data.agents.length === 0 && (
          <div className="card" style={{ marginTop: 12, padding: '28px 20px', textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>No agents yet</div>
            <div className="muted" style={{ marginTop: 6, maxWidth: 460, marginLeft: 'auto', marginRight: 'auto' }}>
              An agent answers your customers and can act — look up orders,
              issue refunds, escalate to a human. Describe what it should do
              and the builder drafts a starting configuration you refine
              through Purpose → Knowledge → Behavior → Actions → Test → Deploy.
            </div>
            {isAdmin && (
              <button className="btn primary" style={{ marginTop: 14 }} onClick={() => navigate('/agents/new')}>
                Create your first agent
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
