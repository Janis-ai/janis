import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MODEL_CATALOG, type Conversation } from '@janis/shared';
import { api } from '../api/client';
import { useAgents, useBuildStatus, useChannels } from '../api/hooks';
import { KIND_LABEL } from '../components/Channels';
import { janisBrain } from '../lib/agentContext';
import { OPEN_ENDED_STEPS, stepGlyph, useSeenSteps } from '../lib/seenSteps';
import { railBus } from '../lib/railBus';
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

const BUILD_STEPS = [
  { key: 'create', label: 'Create' },
  { key: 'teach', label: 'Teach it' },
  { key: 'guide', label: 'Guide it' },
  { key: 'abilities', label: 'Abilities' },
  { key: 'try', label: 'Try it' },
  { key: 'deploy', label: 'Deploy' },
] as const;
type BuildStepKey = (typeof BUILD_STEPS)[number]['key'];

/** Agent home — /agents/:id. The agent's dashboard: what it is, where it is
 *  in its lifecycle (build progress + status), and what's happening — needs-
 *  attention, this week's numbers, recent conversations. */
export function buildStepLink(agentId: string, key: BuildStepKey) {
  return `/agents/new/${agentId}?step=${key}`;
}
export default function AgentOverview() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data: agentsData } = useAgents();
  const agent = agentsData?.agents.find((a) => a.id === id);
  usePageTitle(agent ? agent.name : 'Agent');
  const { data: channelsData } = useChannels();
  const channels = (channelsData?.channels ?? []).filter((c) => c.agent_id === id);
  const { data: buildStatus } = useBuildStatus(id);

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
    enabled: janisBrain(agent),
  });
  const recent = useQuery({
    queryKey: ['conversations', 'overview', id],
    queryFn: () =>
      api<{ conversations: Conversation[] }>(`/api/conversations?agent_id=${id}&limit=50`),
    refetchInterval: 30_000,
  });
  const recentConvs = (recent.data?.conversations ?? []).slice(0, 6);

  // Same head action as the editor — open the agent's test channel in the
  // right rail. Hosted-brain only: external/monitor agents' replies come
  // from an outside platform, the test pipeline can't stand in for them.
  const testChat = useMutation({
    mutationFn: () =>
      api<{ channel_id: string }>(`/api/agents/${id}/test-channel`, { method: 'POST' }),
    onSuccess: (r) =>
      railBus.publish({ channelId: r.channel_id, label: agent?.name ?? '', agentId: id! }),
  });

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

  const hosted = janisBrain(agent);
  const cfg = agent?.config ?? {};
  const summary = cfg.builder?.summary?.trim();
  // Lifecycle line: Live once a public channel exists; Ready when every
  // ACTIONABLE step is done ('na' steps don't count — the agent doesn't
  // need them); otherwise In build with the next actionable step named.
  const actionable = BUILD_STEPS.filter(
    (s) => !buildStatus || buildStatus.steps[s.key] !== 'na',
  );
  const doneCount = buildStatus
    ? actionable.filter((s) => buildStatus.steps[s.key] === 'done').length
    : 0;
  const nextStep = buildStatus
    ? actionable.find((s) => buildStatus.steps[s.key] === 'pending')
    : undefined;
  const seenSteps = useSeenSteps(agent?.id);
  // Ready = every actionable step is done except possibly deploy itself.
  const allBuilt =
    buildStatus &&
    actionable.every(
      (s) => s.key === 'deploy' || buildStatus.steps[s.key] === 'done',
    );
  const status = !hosted
    ? agent?.webhook_url ? 'live' : 'no-webhook'
    : channels.length
      ? 'live'
      : buildStatus && allBuilt
        ? 'ready'
        : 'building';
  const model = cfg.llm?.model
    ? (MODEL_CATALOG.find((m) => m.id === cfg.llm?.model)?.name ?? cfg.llm.model)
    : null;

  return (
    <>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 className="page-title grow">{agent?.name ?? '…'}</h1>
        {agent && (
          <span className={`badge ${agent.hosted ? 'active' : agent.webhook_url ? '' : 'warn'}`}>
            {agent.hosted ? 'hosted' : agent.webhook_url ? 'external' : 'unreachable'}
          </span>
        )}
        {agent && hosted && (
          <button
            className="btn"
            disabled={testChat.isPending}
            title="Chat with this agent in the side rail — real pipeline, test channel"
            onClick={() => testChat.mutate()}
          >
            {testChat.isPending ? 'Opening…' : 'Test agent'}
          </button>
        )}
        <button className="btn" onClick={() => navigate(`/agents/${id}/inbox`)}>
          Inbox
        </button>
        <button
          className="btn primary"
          title="Channels, widget, embed — put this agent to work"
          onClick={() => navigate(`/agents/${id}/channels`)}
        >
          Deploy
        </button>
        <button className="btn" onClick={() => navigate(`/agents/${id}/settings`)}>
          Agent settings
        </button>
      </div>
      <div className="muted" style={{ marginBottom: 12 }}>
        {summary
          ? `It will ${summary.replace(/[.\s]+$/, '')}.`
          : cfg.purpose || (agent?.hosted ? 'hosted by Janis' : 'external webhook')}
        {agent?.last_seen_at ? ` · last event ${timeAgo(agent.last_seen_at)}` : ''}
      </div>

      {/* Lifecycle + build progress — Overview is the home you land on after
          Create, so "where am I / what's next" is the first thing it says. */}
      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <strong className="grow" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              className="status-dot"
              style={{
                background:
                  status === 'live' ? 'var(--ok)' : status === 'ready' ? 'var(--accent)' : 'var(--warn, #f59e0b)',
              }}
            />
            {status === 'live'
              ? channels.length
                ? `Live — answering on ${channels.length} channel${channels.length > 1 ? 's' : ''}`
                : 'Live'
              : status === 'ready'
                ? 'Ready to deploy'
                : status === 'no-webhook'
                  ? 'No webhook URL set'
                  : `In build — ${doneCount} of ${actionable.length} steps done`}
          </strong>
          {nextStep && hosted && (
            <button
              className="btn primary"
              onClick={() => navigate(buildStepLink(id!, nextStep.key))}
            >
              {nextStep.label} →
            </button>
          )}
          {status === 'no-webhook' && (
            <button
              className="btn primary"
              onClick={() => navigate(`/agents/${id}/settings?sub=general`)}
            >
              Set webhook →
            </button>
          )}
        </div>
        {hosted && (
          <div className="build-progress">
            {BUILD_STEPS.map((s) => {
              const state = buildStatus?.steps[s.key] ?? 'pending';
              const na = state === 'na';
              const isNext = state === 'pending' && nextStep?.key === s.key;
              // Same marks as the sidebar/boxes: ✓ for completable steps,
              // ⊙ for open-ended capabilities once engaged (seen or
              // configured), + for addable, ○ unseen.
              const g = stepGlyph(buildStatus?.steps[s.key], {
                openEnded: OPEN_ENDED_STEPS.has(s.key),
                seen: seenSteps.has(s.key),
                isNext,
              });
              const caption =
                s.key === 'teach' && buildStatus?.knowledge.sources
                  ? `${buildStatus.knowledge.sources} source${buildStatus.knowledge.sources > 1 ? 's' : ''}`
                  : s.key === 'abilities' && buildStatus?.abilities
                    ? `${buildStatus.abilities} tool${buildStatus.abilities > 1 ? 's' : ''}`
                  : s.key === 'try' && buildStatus?.test_conversations
                    ? `${buildStatus.test_conversations} test chat${buildStatus.test_conversations > 1 ? 's' : ''}`
                    : s.key === 'deploy' && buildStatus?.channels
                      ? `${buildStatus.channels} channel${buildStatus.channels > 1 ? 's' : ''}`
                      : null;
              return (
                <Link
                  key={s.key}
                  to={buildStepLink(id!, s.key)}
                  className={`bp-item${g === 'check' ? ' done' : ''}${g === 'dot-ok' ? ' engaged' : ''}${isNext ? ' next' : ''}${na ? ' na' : ''}`}
                  title={na ? 'This agent doesn\u2019t need it — add it anytime' : undefined}
                >
                  <span className="bp-mark">{g === 'check' ? '✓' : g === 'plus' ? '+' : g === 'dot-ok' || g === 'dot' || g === 'dot-accent' ? '⊙' : '○'}</span>
                  {s.label}
                  {caption && <span className="muted"> · {caption}</span>}
                </Link>
              );
            })}
          </div>
        )}
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
            <strong>Configuration</strong>
            <div style={{ marginTop: 6, fontSize: 13 }}>
              <div className="row" style={{ padding: '4px 0', gap: 8 }}>
                <span className="muted grow">Model</span>
                <span>{model ? `${model} · custom` : 'Workspace default'}</span>
              </div>
              <div className="row" style={{ padding: '4px 0', gap: 8 }}>
                <span className="muted grow">Brain</span>
                <span>{hosted ? 'Janis hosted' : 'External webhook'}</span>
              </div>
              <div className="row" style={{ padding: '4px 0', gap: 8 }}>
                <span className="muted grow">Escalation</span>
                <span>
                  {cfg.sla_minutes ? `re-alerts after ${cfg.sla_minutes} min` : 'Workspace default'}
                </span>
              </div>
            </div>
          </div>

          {hosted && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="row">
                <strong className="grow">Knowledge</strong>
                <button className="btn" onClick={() => navigate(buildStepLink(id!, 'teach'))}>
                  Teach it
                </button>
              </div>
              <div style={{ marginTop: 6, fontSize: 13 }}>
                <div className="row" style={{ padding: '4px 0', gap: 8 }}>
                  <span className="muted grow">Sources</span>
                  <span>{buildStatus?.knowledge.sources ?? '—'}</span>
                </div>
                <div
                  className="row"
                  style={{ padding: '4px 0', gap: 8, cursor: 'pointer' }}
                  onClick={() => navigate(`/agents/${id}/knowledge?sub=gaps`)}
                >
                  <span className="muted grow">Knowledge gaps</span>
                  <span>{gaps.data ? gapList.length : '—'}</span>
                </div>
                <div className="row" style={{ padding: '4px 0', gap: 8 }}>
                  <span className="muted grow">Last updated</span>
                  <span>
                    {buildStatus?.knowledge.updated_at
                      ? timeAgo(buildStatus.knowledge.updated_at)
                      : 'never'}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="card" style={{ marginTop: 12 }}>
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
        </div>
      </div>
    </>
  );
}
