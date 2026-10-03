import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Conversation } from '@janis/shared';
import { api } from '../api/client';
import { useAgents, useChannels } from '../api/hooks';
import { KIND_LABEL } from '../components/Channels';
import { timeAgo } from '../components/bits';
import { usePageTitle } from '../lib/title';

/** Old /agents/:id?tab=X links resolve to the new section paths. */
const LEGACY_TAB_SECTION: Record<string, string> = {
  connection: 'settings',
  behavior: 'behavior',
  channels: 'channels',
  escalation: 'settings',
  tools: 'integrations',
  tests: 'tests',
  help: 'knowledge',
  llm: 'behavior',
};
const LEGACY_SUB: Record<string, string> = {
  llm: 'llm',
  help: 'help',
  escalation: 'escalation',
  connection: 'general',
};

interface ContainmentMetrics {
  total: number;
  contained: number;
  escalated: number;
  containment_rate: number | null;
  approvals_pending: number;
}
interface HandoffMetrics {
  handoffs: number;
  unresolved: number;
  overdue: number;
}
interface CsatMetrics {
  answered: number;
  avg_score: number | null;
}
interface Gap {
  key: string;
  questions: string[];
  count: number;
}

/** Agent home — /agents/:id. An at-a-glance operational dashboard: what
 *  needs a human right now, this week's containment/CSAT, channel health,
 *  knowledge gaps, and the most recent conversations. */
export default function AgentOverview() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data: agentsData } = useAgents();
  const agent = agentsData?.agents.find((a) => a.id === id);
  usePageTitle(agent ? agent.name : 'Agent');
  const { data: channelsData } = useChannels();
  const channels = (channelsData?.channels ?? []).filter((c) => c.agent_id === id);

  const attention = useQuery({
    queryKey: ['attention', id],
    queryFn: () => api<{ count: number }>(`/api/conversations/attention-count?agent_id=${id}`),
    refetchInterval: 30_000,
  });
  const containment = useQuery({
    queryKey: ['containment', id],
    queryFn: () =>
      api<ContainmentMetrics>(`/api/reports/containment?days=7&agent_id=${id}`),
  });
  const handoffs = useQuery({
    queryKey: ['handoffs', id],
    queryFn: () => api<HandoffMetrics>(`/api/reports/handoffs?days=7&agent_id=${id}`),
  });
  const csat = useQuery({
    queryKey: ['csat', id],
    queryFn: () => api<CsatMetrics>(`/api/reports/csat?days=30&agent_id=${id}`),
  });
  const gaps = useQuery({
    queryKey: ['knowledge-gaps', id],
    queryFn: () =>
      api<{ gaps: Gap[] }>(`/api/agents/${id}/knowledge-gaps`),
    enabled: !!agent?.hosted,
  });
  const recent = useQuery({
    queryKey: ['conversations', 'overview', id],
    queryFn: () =>
      api<{ conversations: Conversation[] }>(`/api/conversations?agent_id=${id}&limit=50`),
    refetchInterval: 30_000,
  });
  const recentConvs = (recent.data?.conversations ?? []).slice(0, 6);

  const tab = params.get('tab');
  if (tab && LEGACY_TAB_SECTION[tab]) {
    return (
      <Navigate
        to={`/agents/${id}/${LEGACY_TAB_SECTION[tab]}${LEGACY_SUB[tab] ? `?sub=${LEGACY_SUB[tab]}` : ''}`}
        replace
      />
    );
  }

  if (agentsData && !agent) {
    return <div className="muted">Agent not found.</div>;
  }
  const needsHuman = attention.data?.count ?? 0;
  const openHandoffs = handoffs.data?.unresolved ?? 0;
  const gapList = gaps.data?.gaps ?? [];

  return (
    <>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 className="page-title grow">{agent?.name ?? '…'}</h1>
        {agent && (
          <span className={`badge ${agent.hosted ? 'active' : agent.webhook_url ? '' : 'warn'}`}>
            {agent.hosted ? 'hosted' : agent.webhook_url ? 'external' : 'unreachable'}
          </span>
        )}
        <button className="btn" onClick={() => navigate(`/agents/${id}/inbox`)}>
          Inbox
        </button>
        <button className="btn" onClick={() => navigate(`/agents/${id}/settings`)}>
          Agent settings
        </button>
      </div>
      <div className="muted" style={{ marginBottom: 12 }}>
        {agent?.hosted ? 'hosted by Janis' : 'external webhook'}
        {agent?.last_seen_at ? ` · last event ${timeAgo(agent.last_seen_at)}` : ' · no events yet'}
      </div>

      {needsHuman > 0 && (
        <div
          className="card"
          style={{ borderColor: 'var(--warn, #f59e0b)', cursor: 'pointer' }}
          onClick={() => navigate(`/agents/${id}/inbox`)}
        >
          <strong>{needsHuman} conversation{needsHuman > 1 ? 's' : ''} need{needsHuman > 1 ? '' : 's'} attention</strong>
          <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
            Customers are waiting on a human — open the inbox.
          </div>
        </div>
      )}

      <div className="card">
        <div className="row">
          <strong className="grow">This week</strong>
          <button className="btn" onClick={() => navigate(`/agents/${id}/reports`)}>
            Reports
          </button>
        </div>
        <div className="metric-grid" style={{ marginTop: 10 }}>
          <div className="metric">
            <div className="metric-num">{containment.data?.total ?? '—'}</div>
            <div className="muted" style={{ fontSize: 12 }}>conversations</div>
          </div>
          <div className="metric">
            <div className="metric-num">
              {containment.data?.containment_rate == null
                ? '—'
                : `${containment.data.containment_rate}%`}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>resolved by AI</div>
          </div>
          <div className="metric">
            <div className="metric-num">{openHandoffs}</div>
            <div className="muted" style={{ fontSize: 12 }}>open handoffs</div>
          </div>
          <div className="metric">
            <div className="metric-num">
              {csat.data?.avg_score == null ? '—' : csat.data.avg_score.toFixed(1)}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>CSAT (30d)</div>
          </div>
        </div>
      </div>

      <div className="row" style={{ alignItems: 'flex-start', gap: 12, marginTop: 12 }}>
        <div className="card grow">
          <div className="row">
            <strong className="grow">Recent conversations</strong>
            <button className="btn" onClick={() => navigate(`/agents/${id}/inbox`)}>
              All
            </button>
          </div>
          {!recentConvs.length ? (
            <div className="muted" style={{ marginTop: 8 }}>
              {recent.data ? 'No conversations yet.' : 'Loading…'}
            </div>
          ) : (
            <div style={{ marginTop: 6 }}>
              {recentConvs.map((conv) => (
                <div
                  key={conv.id}
                  className="row"
                  style={{ padding: '7px 0', borderTop: '1px solid var(--border)', cursor: 'pointer', gap: 8 }}
                  onClick={() => navigate(`/agents/${id}/inbox/${conv.id}`)}
                >
                  <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {conv.is_unread ? <strong>{conv.last_message_preview ?? 'New conversation'}</strong> : conv.last_message_preview ?? 'Conversation'}
                  </span>
                  <span className={`badge ${conv.state}`}>{conv.state.replace('_', ' ')}</span>
                  <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {conv.last_message_at ? timeAgo(conv.last_message_at) : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ width: 300, flexShrink: 0 }}>
          <div className="card">
            <div className="row">
              <strong className="grow">Channels</strong>
              <button className="btn" onClick={() => navigate(`/agents/${id}/channels`)}>
                Manage
              </button>
            </div>
            {!channels.length ? (
              <div className="muted" style={{ marginTop: 8 }}>
                No channels — connect one so customers can reach this agent.
              </div>
            ) : (
              <div style={{ marginTop: 6 }}>
                {channels.map((c) => (
                  <div
                    key={c.id}
                    className="row"
                    style={{ padding: '6px 0', borderTop: '1px solid var(--border)', cursor: 'pointer', gap: 8 }}
                    onClick={() => navigate(`/agents/${id}/channels/${c.id}`)}
                  >
                    <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.name}
                    </span>
                    <span className="badge">{KIND_LABEL[c.kind] ?? c.kind}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {agent?.hosted && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="row">
                <strong className="grow">Knowledge gaps</strong>
                <button className="btn" onClick={() => navigate(`/agents/${id}/knowledge?sub=gaps`)}>
                  Review
                </button>
              </div>
              {!gaps.data ? (
                <div className="muted" style={{ marginTop: 8 }}>Detecting…</div>
              ) : !gapList.length ? (
                <div className="muted" style={{ marginTop: 8 }}>
                  No recurring unanswered questions in the last 30 days.
                </div>
              ) : (
                <div style={{ marginTop: 6 }}>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {gapList.length} recurring question{gapList.length > 1 ? 's' : ''} the agent couldn't answer:
                  </div>
                  {gapList.slice(0, 3).map((g) => (
                    <div
                      key={g.key}
                      style={{ marginTop: 6, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      · {g.questions[0]} <span className="muted">({g.count}×)</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
