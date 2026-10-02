import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Agent,
  AgentConfig,
  AgentSecretMeta,
  AlertRule,
  Channel,
  ToolTemplateInfo,
} from '@janis/shared';
import { api } from '../api/client';
import { useAgentMembers, useAgents, useAlertRules, useChannels, useDeliveries, useMe, useSavedReplies, useSlackChannels, useSlackStatus, useUsers } from '../api/hooks';
import { AgentChannels } from '../components/AgentChannels';
import { HelpCenter } from '../components/HelpCenter';
import { AutosizeText, timeAgo } from '../components/bits';
import { SlackChannelSelect } from '../components/SlackChannelSelect';
import { LlmEditor, type LlmBlock } from '../components/LlmEditor';
import { SavedWidgets } from '../components/WidgetComposer';
import { railBus } from '../lib/railBus';
import { usePageTitle } from '../lib/title';
import { useConfirm } from '../components/Prompt';
import { RefreshCw, Trash2, X } from 'lucide-react';

const RULE_KINDS = ['failure', 'handoff_request', 'keyword', 'inactivity', 'custom_alert', 'auto_assign'] as const;
const TEMPLATE_WEBHOOK = 'http://localhost:9798/webhook';
type Tab = 'channels' | 'escalation' | 'tools' | 'tests' | 'help' | 'connection' | 'llm' | 'behavior';

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const { data } = useAgents();
  const agent = data?.agents.find((a) => a.id === id);
  usePageTitle(agent?.name ?? 'Agent');

  if (data && !agent) {
    return (
      <>
        <h1 className="page-title">Agent not found</h1>
        <Link to="/agents" className="muted">← Back to agents</Link>
      </>
    );
  }
  if (!agent) return null;
  // key remounts the editor (and its drafts) when navigating between agents
  return <AgentEditor key={agent.id} agent={agent} />;
}

function AgentEditor({ agent }: { agent: Agent }) {
  const { data: me } = useMe();
  // Effective admin on THIS agent: workspace admin, the agent's owner, or an
  // agent-scoped user whose grant is admin (their workspace role is 'member').
  const isAdmin =
    me?.user.role === 'admin' ||
    me?.user.role === 'owner' ||
    agent.owner_user_id === me?.user.id ||
    me?.agent_scope?.find((a) => a.id === agent.id)?.role === 'admin';
  const { data: rulesData } = useAlertRules();
  const { data: channelsData } = useChannels();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  // Tab lives in the URL (?tab=…) so refresh/back/deep links keep position.
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  // 'integrations' was the pre-rename key for Channels — keep old links working.
  const tab: Tab =
    tabParam === 'integrations'
      ? 'channels'
      : tabParam && ['channels', 'escalation', 'tools', 'tests', 'help', 'connection', 'llm', 'behavior'].includes(tabParam)
        ? (tabParam as Tab)
        : 'connection';
  const activeTab: Tab =
    (tab === 'tools' || tab === 'tests' || tab === 'llm' || tab === 'help') && !agent.hosted
      ? 'connection'
      : tab;
  // merge — the URL may carry breadcrumb state (?from/&scroll=) or the rail's
  // ?rail= that a wholesale replace would wipe on every tab click
  const setTab = (t: Tab) =>
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (t === 'connection') p.delete('tab');
      else p.set('tab', t);
      return p;
    });
  // ?from=/conversations/<id>[?…]&scroll=<px> — set by the conversation's
  // Details-panel agent link so there's a way back to the same spot.
  const fromParam = params.get('from');
  const backToConv =
    fromParam && fromParam.startsWith('/conversations/')
      ? `${fromParam}${fromParam.includes('?') ? '&' : '?'}scroll=${params.get('scroll') ?? 0}`
      : null;
  const [freshSecret, setFreshSecret] = useState<{ label: string; value: string } | null>(
    () => (location.state as { freshSecret?: { label: string; value: string } })?.freshSecret ?? null,
  );
  const [error, setError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  // draft state — one shared cfg, saved wholesale by the header Save button
  const [name, setName] = useState(agent.name);
  const [cfg, setCfg] = useState<AgentConfig>(agent.config ?? {});
  const [autoResume, setAutoResume] = useState(agent.auto_resume_minutes?.toString() ?? '');
  const [webhookUrl, setWebhookUrl] = useState(agent.webhook_url ?? '');

  // The agent row refetches on SSE invalidation — concierge card approvals,
  // teammate saves. Adopt external changes into the drafts, but never stomp
  // an unsaved edit: a field only follows the server when its draft still
  // equals the value the server last reported.
  const prevAgent = useRef(agent);
  useEffect(() => {
    const prev = prevAgent.current;
    if (prev === agent) return;
    prevAgent.current = agent;
    setName((cur) => (cur === prev.name ? agent.name : cur));
    setAutoResume((cur) =>
      cur === (prev.auto_resume_minutes?.toString() ?? '')
        ? agent.auto_resume_minutes?.toString() ?? ''
        : cur,
    );
    setWebhookUrl((cur) => (cur === (prev.webhook_url ?? '') ? agent.webhook_url ?? '' : cur));
    setCfg((cur) => {
      const prevCfg = (prev.config ?? {}) as Record<string, unknown>;
      const nextCfg = (agent.config ?? {}) as Record<string, unknown>;
      const curR = cur as Record<string, unknown>;
      const next = { ...curR };
      let changed = false;
      for (const key of new Set([...Object.keys(prevCfg), ...Object.keys(nextCfg)])) {
        const serverVal = nextCfg[key];
        if (JSON.stringify(curR[key]) !== JSON.stringify(prevCfg[key])) continue; // user diverged — keep the edit
        if (JSON.stringify(curR[key]) === JSON.stringify(serverVal)) continue;
        if (serverVal === undefined) delete next[key]; else next[key] = serverVal;
        changed = true;
      }
      return changed ? (next as AgentConfig) : cur;
    });
  }, [agent]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
    // channel rows embed agent_name — a rename leaves them stale otherwise;
    // ['channel'] covers the single-channel query on the channel page
    void qc.invalidateQueries({ queryKey: ['channels'] });
    void qc.invalidateQueries({ queryKey: ['channel'] });
    void qc.invalidateQueries({ queryKey: ['rules'] });
    void qc.invalidateQueries({ queryKey: ['deliveries'] });
  };

  const update = useMutation({
    mutationFn: (body: {
      name?: string;
      webhook_url?: string | null;
      hosted?: boolean;
      auto_resume_minutes?: number | null;
      config?: AgentConfig;
    }) => api(`/api/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      refresh();
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    },
    onError: (e) => setError(e.message),
  });

  const testWebhook = useMutation({
    mutationFn: () => api(`/api/agents/${agent.id}/webhook-test`, { method: 'POST' }),
    onError: (e) => setError(e.message),
  });

  // Opens the agent's test channel in the right rail — replaces Ask Janis
  // if it's open (the rail is a single slot).
  const testChat = useMutation({
    mutationFn: () =>
      api<{ channel_id: string }>(`/api/agents/${agent.id}/test-channel`, { method: 'POST' }),
    onSuccess: (r) =>
      railBus.publish({ channelId: r.channel_id, label: agent.name, agentId: agent.id }),
    onError: (e) => setError(e.message),
  });

  const rotateKey = useMutation({
    mutationFn: () =>
      api<{ api_key: string }>(`/api/agents/${agent.id}/rotate-key`, { method: 'POST' }),
    onSuccess: (r) => { setFreshSecret({ label: 'New API key', value: r.api_key }); refresh(); },
    onError: (e) => setError(e.message),
  });

  const rotateSecret = useMutation({
    mutationFn: () =>
      api<{ webhook_secret: string }>(`/api/agents/${agent.id}/rotate-webhook-secret`, { method: 'POST' }),
    onSuccess: (r) => { setFreshSecret({ label: 'New webhook secret', value: r.webhook_secret }); refresh(); },
    onError: (e) => setError(e.message),
  });

  const removeAgent = useMutation({
    mutationFn: () => api(`/api/agents/${agent.id}`, { method: 'DELETE' }),
    onSuccess: () => navigate('/agents'),
    onError: (e) => setError(e.message),
  });

  const addRule = useMutation({
    mutationFn: (body: { kind: string; config: Record<string, unknown> }) =>
      api('/api/rules', {
        method: 'POST',
        body: JSON.stringify({ agent_id: agent.id, ...body }),
      }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  const deleteRule = useMutation({
    mutationFn: (ruleId: string) => api(`/api/rules/${ruleId}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const rules = rulesData?.rules.filter((r) => r.agent_id === agent.id) ?? [];
  const channels = channelsData?.channels.filter((c) => c.agent_id === agent.id) ?? [];
  const tabs: { key: Tab; label: string }[] = [
    { key: 'connection', label: 'Engine' },
    { key: 'behavior', label: 'Behavior' },
    { key: 'channels', label: 'Channels' },
    { key: 'escalation', label: 'Escalation' },
    ...(agent.hosted
      ? [
          { key: 'tools' as Tab, label: 'Tools' },
          { key: 'llm' as Tab, label: 'Language Model' },
          { key: 'tests' as Tab, label: 'Tests' },
          { key: 'help' as Tab, label: 'Help center' },
        ]
      : []),
  ];

  const saveAll = () =>
    update.mutate({
      ...(name.trim() && name.trim() !== agent.name ? { name: name.trim() } : {}),
      ...(agent.hosted ? {} : { webhook_url: webhookUrl || null }),
      auto_resume_minutes: autoResume ? Number(autoResume) : null,
      config: cfg,
    });

  return (
    <>
      <div className="agent-head">
        <div className="row" style={{ alignItems: 'center' }}>
          <Link to="/agents" className="muted">← Agents</Link>
          {backToConv && (
            <Link
              to={backToConv}
              style={{ color: 'var(--accent)', fontSize: 13, whiteSpace: 'nowrap' }}
              title="Return to the conversation at the same scroll spot"
            >
              ← conversation
            </Link>
          )}
          <input
            className="grow"
            style={{ fontWeight: 700, minWidth: 0 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() =>
              name.trim() && name.trim() !== agent.name && update.mutate({ name: name.trim() })
            }
          />
          <span className={`badge ${agent.hosted ? 'active' : agent.webhook_url ? '' : 'warn'}`}>
            {agent.hosted ? 'hosted' : agent.webhook_url ? 'external' : 'unreachable'}
          </span>
          <button
            className="btn"
            disabled={testChat.isPending}
            title="Chat with this agent in the side rail — real pipeline, test channel"
            onClick={() => testChat.mutate()}
          >
            {testChat.isPending ? 'Opening…' : 'Test agent'}
          </button>
          <button className="btn primary" disabled={update.isPending} onClick={saveAll}>
            {update.isPending ? 'Saving…' : savedFlash ? 'Saved ✓' : 'Save'}
          </button>
        </div>
        <div className="muted" style={{ marginTop: 10 }}>
          {agent.last_seen_at ? `last event ${timeAgo(agent.last_seen_at)}` : 'no events yet'}
          {channels.length > 0 && ` · channels: ${channels.map((c) => c.name).join(', ')}`}
        </div>
        <div className="tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={`tab${activeTab === t.key ? ' active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {confirmEl}
      {error && <div className="error">{error}</div>}

      {activeTab === 'channels' && <AgentChannels agent={agent} />}
      {activeTab === 'help' && <HelpCenter agent={agent} />}
      {activeTab === 'escalation' && (
        <EscalationTab
          agent={agent}
          cfg={cfg}
          setCfg={setCfg}
          autoResume={autoResume}
          setAutoResume={setAutoResume}
          rules={rules}
          isAdmin={isAdmin}
          onAddRule={(kind, config) => addRule.mutate({ kind, config })}
          onDeleteRule={(rid) => deleteRule.mutate(rid)}
        />
      )}
      {activeTab === 'tools' && agent.hosted && (
        <>
          <ToolsTab cfg={cfg} setCfg={setCfg} agentId={agent.id} isAdmin={isAdmin} />
          <SavedWidgets agentId={agent.id} isAdmin={isAdmin} tools={(cfg.tools ?? []).map((t) => t.name)} />
        </>
      )}
      {activeTab === 'llm' && agent.hosted && (
        <LlmCard agent={agent} cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
      )}
      {activeTab === 'behavior' && (
        <BehaviorSection
          agent={agent}
          cfg={cfg}
          setCfg={setCfg}
          isAdmin={isAdmin}
          hosted={agent.hosted}
        />
      )}
      {activeTab === 'tests' && agent.hosted && <TestsTab agentId={agent.id} agent={agent} isAdmin={isAdmin} />}
      {activeTab === 'connection' && (
        <ConnectionTab
          agent={agent}
          cfg={cfg}
          setCfg={setCfg}
          isAdmin={isAdmin}
          webhookUrl={webhookUrl}
          setWebhookUrl={setWebhookUrl}
          onSaveHosted={(hosted) => update.mutate({ hosted })}
          onTestWebhook={() => testWebhook.mutate()}
          onRotateKey={() => rotateKey.mutate()}
          onRotateSecret={() => rotateSecret.mutate()}
          onRevealSecret={async () => {
            const r = await api<{ webhook_secret: string }>(`/api/agents/${agent.id}/webhook-secret`);
            setFreshSecret({ label: 'Webhook secret', value: r.webhook_secret });
          }}
          freshSecret={freshSecret}
        />
      )}

      {isAdmin && (
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button
            className="btn danger"
            onClick={async () => {
              if (await confirm(`Delete agent "${agent.name}"? Its channels, conversations, and settings are removed.`, [{ key: 'ok', label: 'Delete', danger: true }])) removeAgent.mutate();
            }}
          >
            Delete agent
          </button>
          <button className="btn primary" disabled={update.isPending} onClick={saveAll}>
            {update.isPending ? 'Saving…' : savedFlash ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      )}
    </>
  );
}

/* ---- tabs ---- */

type SlackRoute = { installation_id: string; channel_id: string | null };

const instLabel = (i?: { team_name: string | null; team_id: string }) =>
  i?.team_name ?? i?.team_id ?? 'Slack';

/** One destination row: a Slack workspace + channel pair. Fetches that
 * install's channel list itself so rows can span workspaces. */
function SlackRouteRow({
  route,
  installations,
  agentName,
  busy,
  onChange,
  onRemove,
  onError,
}: {
  route: SlackRoute;
  installations: { id: string; team_name: string | null; team_id: string; alert_channel_id: string | null }[];
  agentName: string;
  busy: boolean;
  onChange: (route: SlackRoute) => void;
  onRemove: () => void;
  onError: (m: string) => void;
}) {
  const { data: slackChannels } = useSlackChannels(true, route.installation_id);
  const qc = useQueryClient();
  const inst = installations.find((i) => i.id === route.installation_id);
  const instChannel = slackChannels?.channels.find((ch) => ch.id === inst?.alert_channel_id);
  const createChannel = useMutation({
    mutationFn: (name: string) =>
      api<{ channel: { id: string; name: string } }>('/api/slack/channel', {
        method: 'POST',
        body: JSON.stringify({ name, installation_id: route.installation_id }),
      }),
    onSuccess: (res) => {
      qc.setQueryData<{ channels: { id: string; name: string }[] }>(
        ['slackChannels', route.installation_id],
        (old) => ({
          channels: old?.channels.some((ch) => ch.id === res.channel.id)
            ? old.channels
            : [...(old?.channels ?? []), res.channel],
        }),
      );
      onChange({ ...route, channel_id: res.channel.id });
    },
    onError: (e) => onError(e.message),
  });
  return (
    <div className="row" style={{ marginBottom: 8 }}>
      <select
        value={route.installation_id}
        disabled={busy}
        onChange={(e) =>
          // switching workspaces invalidates the channel — reset to that
          // install's own alert channel
          onChange({ installation_id: e.target.value, channel_id: null })
        }
      >
        {installations.map((i) => (
          <option key={i.id} value={i.id}>
            {instLabel(i)}
          </option>
        ))}
      </select>
      <SlackChannelSelect
        channels={slackChannels?.channels}
        truncated={slackChannels?.truncated}
        value={route.channel_id ?? ''}
        inheritLabel={
          instChannel ? `Alert channel (#${instChannel.name})` : 'Alert channel (default)'
        }
        defaultName={`janis-${agentName}`}
        busy={busy || createChannel.isPending}
        onPick={(id) => onChange({ ...route, channel_id: id })}
        onCreate={async (name) => {
          await createChannel.mutateAsync(name);
        }}
      />
      <button className="btn" disabled={busy} onClick={onRemove} title="Remove destination" aria-label="Remove destination">
        <X size={14} />
      </button>
    </div>
  );
}

/** Per-agent Slack alert routing — a list of workspace+channel destinations.
 * No routes = inherit the workspace default; an empty list = Slack alerts
 * off for this agent. */
function SlackAlerts({ agent, isAdmin }: { agent: Agent; isAdmin: boolean }) {
  const { data: slack } = useSlackStatus();
  const installations = slack?.installations ?? [];
  const routes = agent.slack_routes;
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
    void qc.invalidateQueries({ queryKey: ['slackChannels'] });
  };
  const setRoutes = useMutation({
    mutationFn: (next: SlackRoute[] | null) =>
      api(`/api/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ slack_routes: next }),
      }),
    onSuccess: refresh,
    onError: (e) => setMsg(e.message),
  });
  if (!slack) return null;
  const defInst = installations[0];
  const patchRoute = (i: number, route: SlackRoute | null) => {
    if (!routes) return;
    const next = [...routes];
    if (route === null) next.splice(i, 1);
    else next[i] = route;
    setRoutes.mutate(next);
  };
  const describe = (r: SlackRoute) => {
    const inst = installations.find((i) => i.id === r.installation_id);
    return `${instLabel(inst)}${r.channel_id ? '' : ' (default channel)'}`;
  };
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <strong>Slack alerts</strong>
      <div className="muted" style={{ margin: '4px 0 8px' }}>
        Where this agent's escalations post. Add destinations to alert several Slack
        workspaces/channels — any destination turns the workspace default off.
      </div>
      {!slack.connected ? (
        isAdmin ? (
          slack.configured ? (
            <a className="btn primary" style={{ display: 'inline-block', marginTop: 8 }} href="/api/slack/install">Connect Slack</a>
          ) : (
            <div className="muted">
              Set SLACK_CLIENT_ID / SLACK_CLIENT_SECRET on the API to enable Slack alerts.
            </div>
          )
        ) : (
          <div className="muted">No Slack workspace connected — alerts stay in the inbox.</div>
        )
      ) : isAdmin ? (
        <>
          {routes === null ? (
            <div className="row">
              <span className="muted">
                Inheriting the workspace default ({instLabel(defInst)})
              </span>
              <button
                className="btn"
                disabled={setRoutes.isPending}
                onClick={() =>
                  setRoutes.mutate([{ installation_id: defInst.id, channel_id: null }])
                }
              >
                Customize destinations
              </button>
              <button
                className="btn"
                disabled={setRoutes.isPending}
                onClick={() => setRoutes.mutate([])}
              >
                Turn off Slack alerts
              </button>
              {slack.configured && (
                <a className="btn" href="/api/slack/install">Add workspace</a>
              )}
            </div>
          ) : (
            <>
              {routes.map((r, i) => (
                <SlackRouteRow
                  key={i}
                  route={r}
                  installations={installations}
                  agentName={agent.name}
                  busy={setRoutes.isPending}
                  onChange={(route) => patchRoute(i, route)}
                  onRemove={() => patchRoute(i, null)}
                  onError={setMsg}
                />
              ))}
              {routes.length === 0 && (
                <div className="muted" style={{ marginBottom: 8 }}>
                  No destinations — Slack alerts are off for this agent.
                </div>
              )}
              <div className="row">
                <button
                  className="btn"
                  disabled={setRoutes.isPending || routes.length >= 8}
                  onClick={() =>
                    setRoutes.mutate([
                      ...routes,
                      { installation_id: defInst.id, channel_id: null },
                    ])
                  }
                >
                  + Add destination
                </button>
                {slack.configured && (
                  <a className="btn" href="/api/slack/install">Add workspace</a>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        <div className="muted">
          {routes === null
            ? `Workspace default (${instLabel(defInst)})`
            : routes.length === 0
              ? 'Slack alerts are off for this agent.'
              : routes.map(describe).join(', ')}
        </div>
      )}
      {msg && <div className="muted" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

/** Disables every form control inside for members — agent configuration is
 *  admin-managed, members get a read-only view. */
const ReadOnly = ({ children, off }: { children: React.ReactNode; off: boolean }) =>
  off ? (
    <fieldset disabled style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: 'contents' }}>
      {children}
    </fieldset>
  ) : (
    <>{children}</>
  );

function BehaviorSection({
  agent,
  cfg,
  setCfg,
  isAdmin,
  hosted,
}: {
  agent: Agent;
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  isAdmin: boolean;
  hosted: boolean;
}) {
  const joinLines = (v: unknown) => (Array.isArray(v) ? (v as string[]).join('\n') : '');
  const joinCsv = (v: unknown) => (Array.isArray(v) ? (v as string[]).join(', ') : '');
  const [knowledgeText, setKnowledgeText] = useState(() => joinLines(cfg.knowledge));
  const [repliesText, setRepliesText] = useState(() => joinCsv(cfg.quick_replies));
  // Follow external writes into cfg (concierge approvals, teammate saves via
  // SSE refetch) — unless the user has diverged from the last server value
  // in this field, in which case the in-progress edit wins.
  const knowledgeBase = joinLines(cfg.knowledge);
  const knowledgeBaseRef = useRef(knowledgeBase);
  useEffect(() => {
    if (knowledgeBase === knowledgeBaseRef.current) return;
    setKnowledgeText((cur) => (cur === knowledgeBaseRef.current ? knowledgeBase : cur));
    knowledgeBaseRef.current = knowledgeBase;
  }, [knowledgeBase]);
  const repliesBase = joinCsv(cfg.quick_replies);
  const repliesBaseRef = useRef(repliesBase);
  useEffect(() => {
    if (repliesBase === repliesBaseRef.current) return;
    setRepliesText((cur) => (cur === repliesBaseRef.current ? repliesBase : cur));
    repliesBaseRef.current = repliesBase;
  }, [repliesBase]);

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
      <strong>{hosted ? 'Behavior' : 'Greeting'}</strong>
      <ReadOnly off={!isAdmin}>
      <label className="check-label">
        <input
          type="checkbox"
          checked={cfg.greeting_enabled !== false}
          onChange={(e) => setCfg({ ...cfg, greeting_enabled: e.target.checked })}
        />
        Greet customers when a conversation starts
      </label>
      {cfg.greeting_enabled !== false && (
        <>
          <label>
            Greeting text — leave blank and a hosted agent writes its own
            (channel widgets can override)
          </label>
          <input
            placeholder="Hi! How can we help?"
            value={cfg.greeting ?? ''}
            onChange={(e) => setCfg({ ...cfg, greeting: e.target.value })}
          />
          <label>
            Suggested replies — comma-separated prompts customers can tap (webchat chips;
            reply buttons on Messenger/IG/WhatsApp greetings)
          </label>
          <input
            placeholder="e.g. Pricing questions, Talk to a human, How does this work?"
            value={repliesText}
            onChange={(e) => setRepliesText(e.target.value)}
            onBlur={() =>
              setCfg({
                ...cfg,
                quick_replies: repliesText.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
              })
            }
          />
        </>
      )}
      {hosted && (
        <>
          <label>System prompt</label>
          <textarea
            rows={4}
            placeholder="You are the support agent for Acme Co. You help with orders, returns…"
            value={cfg.system_prompt ?? ''}
            onChange={(e) => setCfg({ ...cfg, system_prompt: e.target.value })}
          />
          <label>Knowledge base — one fact/snippet per line</label>
          <textarea
            rows={5}
            placeholder={'Refunds are allowed within 30 days of purchase.\nSupport hours are 9-5 ET.\nOrder lookup requires the order number.'}
            value={knowledgeText}
            onChange={(e) => setKnowledgeText(e.target.value)}
            onBlur={() => setCfg({ ...cfg, knowledge: knowledgeText.split('\n').filter(Boolean) })}
          />
          <label>Tone</label>
          <textarea
            rows={2}
            placeholder="e.g. warm, concise, never apologetic"
            value={cfg.tone ?? ''}
            onChange={(e) => setCfg({ ...cfg, tone: e.target.value })}
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={cfg.auto_archive === true}
              onChange={(e) => setCfg({ ...cfg, auto_archive: e.target.checked || undefined })}
            />
            Auto-archive resolved chats — when the customer confirms they're done, the
            agent signs off and archives the thread (fires the CSAT survey)
          </label>
          <label>Knowledge files — PDFs, docs, text, images; the agent answers from these</label>
          <KnowledgeFiles agentId={agent.id} />
          <KnowledgeGaps agentId={agent.id} config={agent.config ?? {}} />
        </>
      )}
      </ReadOnly>
    </div>
  );
}

function EscalationTab({
  agent,
  cfg,
  setCfg,
  autoResume,
  setAutoResume,
  rules,
  isAdmin,
  onAddRule,
  onDeleteRule,
}: {
  agent: Agent;
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  autoResume: string;
  setAutoResume: (s: string) => void;
  rules: AlertRule[];
  isAdmin: boolean;
  onAddRule: (kind: string, config: Record<string, unknown>) => void;
  onDeleteRule: (id: string) => void;
}) {
  const [kind, setKind] = useState<(typeof RULE_KINDS)[number]>('keyword');
  const [keywords, setKeywords] = useState('');
  const [intents, setIntents] = useState('');
  const [minutes, setMinutes] = useState('15');
  const [assignTo, setAssignTo] = useState('');
  const [ruleTag, setRuleTag] = useState('');
  const [pool, setPool] = useState<string[]>([]);
  const { data: members } = useAgentMembers(agent.id);
  const teammateName = (id: string) =>
    members?.members.find((m) => m.user_id === id)?.name ?? 'a teammate';

  return (
    <>
    {/* Team and the profile/notify overrides are self-service or gate
        themselves on isAdmin, so they sit outside the admin read-only
        wrapper. */}
    <AgentTeamCard agent={agent} isAdmin={isAdmin} />
    <AgentProfileOverride agent={agent} />
    <AgentNotifyOverride agent={agent} />
    <ReadOnly off={!isAdmin}>
      <div className="card" style={{ marginTop: 12 }}>
        <strong>Human takeover</strong>
        <div className="form-field" style={{ marginTop: 8 }}>
          <label>Auto-resume — release a takeover back to the agent after N minutes</label>
          <div className="row">
            <input
              type="number"
              min={1}
              className="num-input"
              placeholder="minutes"
              value={autoResume}
              onChange={(e) => setAutoResume(e.target.value)}
            />
            <span className="muted">blank = never auto-resume</span>
          </div>
        </div>
        <div className="form-field">
          <label>Escalation SLA — re-alert when a handoff stays unclaimed</label>
          <div className="row">
            <input
              type="number"
              min={1}
              className="num-input"
              placeholder="minutes"
              value={cfg.sla_minutes ?? ''}
              onChange={(e) =>
                setCfg({ ...cfg, sla_minutes: e.target.value ? Number(e.target.value) : undefined })
              }
            />
            <span className="muted">blank = off</span>
          </div>
        </div>
        <div className="form-field">
          <label className="check-label">
            <input
              type="checkbox"
              checked={cfg.auto_assign ?? false}
              onChange={(e) => setCfg({ ...cfg, auto_assign: e.target.checked })}
            />
            Auto-assign handoffs to the least-loaded teammate
          </label>
        </div>
        <div className="muted">Repeat breaches escalate to the Slack alert channel.</div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <strong>Satisfaction survey</strong>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Overrides the workspace survey for this agent — blank fields inherit.
        </div>
        <div className="form-field" style={{ marginTop: 8 }}>
          <label className="check-label">
            <input
              type="checkbox"
              checked={cfg.csat?.enabled !== undefined}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  csat: e.target.checked
                    ? { ...(cfg.csat ?? {}), enabled: true }
                    : cfg.csat && (cfg.csat.prompt || cfg.csat.thanks)
                      ? { prompt: cfg.csat.prompt, thanks: cfg.csat.thanks }
                      : undefined,
                })
              }
            />
            Override workspace on/off for this agent
          </label>
          {cfg.csat?.enabled !== undefined && (
            <select
              value={cfg.csat.enabled ? 'on' : 'off'}
              onChange={(e) =>
                setCfg({ ...cfg, csat: { ...(cfg.csat ?? {}), enabled: e.target.value === 'on' } })
              }
              style={{ marginLeft: 24 }}
            >
              <option value="on">Survey on</option>
              <option value="off">Survey off</option>
            </select>
          )}
        </div>
        <div className="form-field">
          <label>Survey question</label>
          <AutosizeText
            value={cfg.csat?.prompt ?? ''}
            placeholder="Workspace default"
            onChange={(v) =>
              setCfg({
                ...cfg,
                csat: { ...(cfg.csat ?? {}), prompt: v || undefined },
              })
            }
          />
        </div>
        <div className="form-field">
          <label>Thank-you reply</label>
          <AutosizeText
            value={cfg.csat?.thanks ?? ''}
            placeholder="Workspace default"
            onChange={(v) =>
              setCfg({
                ...cfg,
                csat: { ...(cfg.csat ?? {}), thanks: v || undefined },
              })
            }
          />
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <strong>Alert &amp; routing rules</strong>
        {rules.map((r) => (
          <div key={r.id} className="row muted" style={{ marginTop: 6 }}>
            <span className="grow">
              {r.kind === 'auto_assign' ? 'auto-assign new conversations' : r.kind}
              {r.config.keywords?.length ? `: ${r.config.keywords.join(', ')}` : ''}
              {(r.config.intents?.length ?? 0) > 0 && ` · intent: ${(r.config.intents ?? []).join(', ')}`}
              {r.config.inactivity_minutes ? ` (${r.config.inactivity_minutes}m)` : ''}
              {r.config.assign_to ? ` → ${teammateName(r.config.assign_to)}` : ''}
              {r.config.assignees?.length
                ? ` → ${r.config.assignees.map(teammateName).join(', ')} (round robin)`
                : ''}
              {r.config.tag ? ` +tag:${r.config.tag}` : ''}
            </span>
            <button className="btn danger" onClick={() => onDeleteRule(r.id)} aria-label="Delete rule"><Trash2 size={14} /></button>
          </div>
        ))}
        <div className="row" style={{ marginTop: 8 }}>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {RULE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k === 'auto_assign' ? 'auto-assign' : k}
              </option>
            ))}
          </select>
          {kind === 'keyword' && (
            <>
              <input
                className="grow"
                placeholder="keywords, comma separated"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
              />
              <input
                style={{ width: 150 }}
                placeholder="or intent: billing, …"
                value={intents}
                onChange={(e) => setIntents(e.target.value)}
              />
            </>
          )}
          {kind === 'inactivity' && (
            <input
              type="number"
              min={1}
              style={{ width: 90 }}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          )}
          {(kind === 'keyword' || kind === 'inactivity') && (
            <>
              <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                <option value="">no assignee</option>
                {(members?.members ?? []).map((m) => (
                  <option key={m.user_id} value={m.user_id}>{m.name}</option>
                ))}
              </select>
              <input
                style={{ width: 110 }}
                placeholder="+ tag"
                value={ruleTag}
                onChange={(e) => setRuleTag(e.target.value)}
              />
            </>
          )}
          {kind === 'auto_assign' && (
            <span className="muted" style={{ fontSize: 12 }}>
              {(members?.members ?? []).map((m) => (
                <label key={m.user_id} className="check-label" style={{ marginRight: 8 }}>
                  <input
                    type="checkbox"
                    checked={pool.includes(m.user_id)}
                    onChange={(e) =>
                      setPool(
                        e.target.checked
                          ? [...pool, m.user_id]
                          : pool.filter((id) => id !== m.user_id),
                      )
                    }
                  />
                  {m.name}
                </label>
              ))}
            </span>
          )}
          <button
            className="btn"
            disabled={kind === 'auto_assign' && pool.length === 0}
            onClick={() =>
              onAddRule(kind, {
                enabled: true,
                ...(kind === 'keyword'
                  ? {
                      keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
                      intents: intents.split(',').map((k) => k.trim()).filter(Boolean),
                    }
                  : {}),
                ...(kind === 'inactivity' ? { inactivity_minutes: Number(minutes) } : {}),
                ...(assignTo ? { assign_to: assignTo } : {}),
                ...(ruleTag.trim() ? { tag: ruleTag.trim() } : {}),
                ...(kind === 'auto_assign' ? { assignees: pool, next: 0 } : {}),
              })
            }
          >
            Add rule
          </button>
        </div>
        <div className="form-field" style={{ marginTop: 10 }}>
          <label>Intent labels — topics the classifier tags each new conversation with</label>
          <input
            defaultValue={(cfg.intents ?? []).join(', ')}
            placeholder="billing, shipping, technical issue, sales, other (blank = default topics)"
            onBlur={(e) =>
              setCfg({
                ...cfg,
                intents: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <span className="muted" style={{ fontSize: 12 }}>
            Rules above can fire on these intents — classify once, route automatically.
          </span>
        </div>
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          auto-assign hands every new conversation to the next teammate in the pool; keyword and
          inactivity rules can also assign the thread and tag it when they fire.
        </div>
      </div>

      <SlackAlerts agent={agent} isAdmin={isAdmin} />

      <AgentSavedRepliesCard agent={agent} />
    </ReadOnly>
    </>
  );
}

/** Profile override — the operator's identity on THIS agent's channels.
 *  Self-service: each teammate sets their own; fields inherit the workspace
 *  profile until overridden. */
function AgentProfileOverride({ agent }: { agent: Agent }) {
  const { data: me } = useMe();
  const { data: members } = useAgentMembers(agent.id);
  const qc = useQueryClient();
  const mine = members?.members.find((m) => m.user_id === me?.user.id);
  const [on, setOn] = useState<boolean | null>(null);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [show, setShow] = useState(true);
  const [msg, setMsg] = useState('');

  const hasOverride = Boolean(
    mine && (mine.display_name || mine.avatar_override || mine.show_identity !== null),
  );
  useEffect(() => {
    if (on !== null || !members) return;
    setOn(hasOverride);
    setName(mine?.display_name ?? '');
    setAvatar(mine?.avatar_override ?? '');
    setShow(mine?.show_identity ?? me?.user.show_identity ?? true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/agents/${agent.id}/members/${me?.user.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setMsg('Saved.');
      void qc.invalidateQueries({ queryKey: ['agentMembers', agent.id] });
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'failed'),
  });

  const uploadAvatar = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'include' });
    if (res.ok) setAvatar(((await res.json()) as { url: string }).url);
  };

  const baseName = me?.user.display_name || me?.user.name.split(' ')[0] || 'your profile name';
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <strong>Profile override</strong>
      <div className="muted" style={{ margin: '4px 0 8px' }}>
        Your name &amp; avatar as customers see them on this agent's channels.
        Off — inherits your workspace profile ({baseName}).
      </div>
      <label className="check-label">
        <input
          type="checkbox"
          checked={on ?? false}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            if (!next) {
              save.mutate({ display_name: null, avatar_url: null, show_identity: null });
            }
          }}
        />
        Use a different identity on this agent
      </label>
      {on && (
        <div className="form-field" style={{ marginTop: 8 }}>
          <div className="row">
            <input
              style={{ maxWidth: 220 }}
              placeholder={baseName}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
            <label className="btn" style={{ cursor: 'pointer' }}>
              {avatar ? 'Change avatar' : 'Upload avatar'}
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => e.target.files?.[0] && void uploadAvatar(e.target.files[0])}
              />
            </label>
            {avatar && (
              <img
                src={avatar}
                alt="avatar"
                style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }}
              />
            )}
          </div>
          <label className="check-label" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={show}
              onChange={(e) => setShow(e.target.checked)}
            />
            Show my name &amp; avatar to customers on this agent
          </label>
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({
                  display_name: name.trim() || null,
                  avatar_url: avatar || null,
                  show_identity: show,
                })
              }
            >
              Save identity
            </button>
            {msg && <span className="muted">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Notifications override — this user's push/email/sound for THIS agent's
 *  alerts, field-wise over their workspace prefs. */
function AgentNotifyOverride({ agent }: { agent: Agent }) {
  const { data: me } = useMe();
  const { data: members } = useAgentMembers(agent.id);
  const qc = useQueryClient();
  const mine = members?.members.find((m) => m.user_id === me?.user.id);
  const [on, setOn] = useState<boolean | null>(null);
  const [prefs, setPrefs] = useState({ push: true, email: true, sound: true });
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (on !== null || !members) return;
    setOn(mine?.notify != null);
    const n = mine?.notify ?? {};
    setPrefs({
      push: n.push ?? me?.user.notify?.push ?? true,
      email: n.email ?? me?.user.notify?.email ?? true,
      sound: n.sound ?? me?.user.notify?.sound ?? true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);

  const save = useMutation({
    mutationFn: (notify: Record<string, boolean> | null) =>
      api(`/api/agents/${agent.id}/members/${me?.user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ notify }),
      }),
    onSuccess: () => {
      setMsg('Saved.');
      void qc.invalidateQueries({ queryKey: ['agentMembers', agent.id] });
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'failed'),
  });

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <strong>Notifications override</strong>
      <div className="muted" style={{ margin: '4px 0 8px' }}>
        Alert delivery for this agent only — off, your workspace notification
        settings apply.
      </div>
      <label className="check-label">
        <input
          type="checkbox"
          checked={on ?? false}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            save.mutate(next ? prefs : null);
          }}
        />
        Custom notifications for this agent
      </label>
      {on && (
        <div className="row" style={{ marginTop: 8 }}>
          {(['push', 'email', 'sound'] as const).map((k) => (
            <label key={k} className="check-label">
              <input
                type="checkbox"
                checked={prefs[k]}
                onChange={(e) => {
                  const next = { ...prefs, [k]: e.target.checked };
                  setPrefs(next);
                  save.mutate(next);
                }}
              />
              {k === 'push' ? 'Web push' : k === 'email' ? 'Email' : 'Alert sounds'}
            </label>
          ))}
          {msg && <span className="muted">{msg}</span>}
        </div>
      )}
    </div>
  );
}

/** Agent-scoped saved replies — merge with workspace replies in this agent's
 *  composer. Any agent member can add; workspace replies stay managed under
 *  Settings. */
function AgentSavedRepliesCard({ agent }: { agent: Agent }) {
  const { data } = useSavedReplies(agent.id);
  const qc = useQueryClient();
  const [reply, setReply] = useState({ title: '', body: '' });
  const [err, setErr] = useState('');
  const own = data?.saved_replies.filter((r) => r.agent_id === agent.id) ?? [];
  const inherited = data?.saved_replies.filter((r) => !r.agent_id) ?? [];

  const add = useMutation({
    mutationFn: (b: typeof reply) =>
      api('/api/saved-replies', {
        method: 'POST',
        body: JSON.stringify({ ...b, agent_id: agent.id }),
      }),
    onSuccess: () => {
      setReply({ title: '', body: '' });
      void qc.invalidateQueries({ queryKey: ['savedReplies'] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'failed'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/saved-replies/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['savedReplies'] }),
  });

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <strong>Saved replies</strong>
      <div className="muted" style={{ margin: '4px 0 8px' }}>
        Extra canned responses for this agent's composer.
        {inherited.length > 0 &&
          ` ${inherited.length} workspace ${inherited.length === 1 ? 'reply' : 'replies'} also apply.`}
      </div>
      {own.map((r) => (
        <div key={r.id} className="row muted" style={{ marginTop: 6 }}>
          <span className="grow">
            <strong>{r.title}</strong> — {r.body.slice(0, 80)}
          </span>
          <button className="btn danger" onClick={() => remove.mutate(r.id)} aria-label="Delete saved reply"><Trash2 size={14} /></button>
        </div>
      ))}
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, maxWidth: 520 }}
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(reply);
        }}
      >
        <input
          placeholder="title"
          value={reply.title}
          onChange={(e) => setReply({ ...reply, title: e.target.value })}
          required
        />
        <textarea
          placeholder="reply text…"
          rows={2}
          value={reply.body}
          onChange={(e) => setReply({ ...reply, body: e.target.value })}
          required
        />
        <div>
          <button className="btn" disabled={add.isPending}>Add agent reply</button>
        </div>
      </form>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

/** Team — who can see and manage this agent. Workspace members inherit their
 *  workspace role; a role here overrides it for this agent only; users added
 *  with no workspace membership see ONLY this agent. */
function AgentTeamCard({ agent, isAdmin }: { agent: Agent; isAdmin: boolean }) {
  const { data: me } = useMe();
  const { data: members } = useAgentMembers(agent.id);
  const { data: wsUsers } = useUsers();
  const qc = useQueryClient();
  const [confirmEl, confirm] = useConfirm();
  const [form, setForm] = useState({ email: '', role: 'member' });
  const [err, setErr] = useState('');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['agentMembers', agent.id] });
    void qc.invalidateQueries({ queryKey: ['users'] });
  };
  const add = useMutation({
    mutationFn: (b: typeof form) =>
      api(`/api/agents/${agent.id}/members`, { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => {
      setForm({ email: '', role: 'member' });
      setErr('');
      refresh();
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'failed'),
  });
  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string | null }) =>
      api(`/api/agents/${agent.id}/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    onSuccess: refresh,
    onError: (e) => setErr(e instanceof Error ? e.message : 'failed'),
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/agents/${agent.id}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => setErr(e instanceof Error ? e.message : 'failed'),
  });

  const wsById = new Map((wsUsers?.users ?? []).map((u) => [u.id, u]));
  const memberRows = members?.members ?? [];
  const agentOnly = memberRows.filter((m) => !wsById.has(m.user_id));
  const wsWithOverride = new Set(memberRows.map((m) => m.user_id));
  const plainMembers = (wsUsers?.users ?? []).filter((u) => !wsWithOverride.has(u.id));
  const ownerId = agent.owner_user_id;
  const isOwner = me?.user.id === ownerId;

  const roleBadge = (v: string) =>
    v === 'hidden' ? 'no privileges (hidden)' : v;

  const roleSelect = (
    userId: string,
    value: string,
    inherited: string | null,
    wsMember: boolean,
  ) => {
    // The owner is fixed — the only way out is transferring ownership,
    // which only they can do (an "owner" option appears on other rows).
    if (userId === ownerId) return <span className="badge active">owner</span>;
    if (!isAdmin) {
      return <span className="badge active">{roleBadge(value === 'inherit' ? (inherited ?? 'member') : value)}</span>;
    }
    return (
      <select
        value={value}
        onChange={(e) => {
          const role = e.target.value;
          if (role !== 'owner') {
            setRole.mutate({ userId, role: role === 'inherit' ? null : role });
            return;
          }
          void (async () => {
            if (await confirm('Transfer ownership of this agent? They become owner — you stay an admin but lose ownership.', undefined, true))
              setRole.mutate({ userId, role });
          })();
        }}
      >
        {inherited !== null && <option value="inherit">inherit ({inherited})</option>}
        <option value="member">member</option>
        <option value="admin">admin</option>
        {wsMember && <option value="hidden">no privileges (hidden)</option>}
        {isOwner && <option value="owner">owner (transfer)</option>}
      </select>
    );
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      {confirmEl}
      <strong>Team</strong>
      <div className="muted" style={{ margin: '4px 0 8px' }}>
        Workspace members can see every agent — a role set here overrides
        theirs for this agent only, and "no privileges" hides it from them
        entirely. People added with no workspace account become agent-only
        users who see nothing but this agent.
      </div>
      {plainMembers.map((u) => (
        <div key={u.id} className="row muted" style={{ marginTop: 6 }}>
          <span className="grow">
            {u.name} · {u.email}
          </span>
          {roleSelect(u.id, 'inherit', u.role, true)}
        </div>
      ))}
      {memberRows
        .filter((m) => wsById.has(m.user_id))
        .map((m) => (
          <div key={m.user_id} className="row muted" style={{ marginTop: 6 }}>
            <span className="grow">
              {m.name} · {m.email}
              <span className="badge" style={{ marginLeft: 8 }}>override</span>
            </span>
            {roleSelect(m.user_id, m.role ?? 'inherit', wsById.get(m.user_id)?.role ?? 'member', true)}
          </div>
        ))}
      {agentOnly.map((m) => (
        <div key={m.user_id} className="row muted" style={{ marginTop: 6 }}>
          <span className="grow">
            {m.name} · {m.email}
            <span className="badge" style={{ marginLeft: 8 }}>this agent only</span>
          </span>
          {roleSelect(m.user_id, m.role ?? 'member', null, false)}
          {isAdmin && m.user_id !== ownerId && (
            <button className="btn danger" onClick={() => remove.mutate(m.user_id)} title="Remove access">
              Remove
            </button>
          )}
        </div>
      ))}
      {isAdmin && (
        <form
          className="row"
          style={{ marginTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(form);
          }}
        >
          <input
            className="grow"
            type="email"
            placeholder="teammate@email.com"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button className="btn" disabled={add.isPending}>Add</button>
        </form>
      )}
      <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
        New emails sign in with Google or Slack under that address — no
        workspace invite needed for agent-only access.
      </div>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

function ToolsTab({
  cfg,
  setCfg,
  agentId,
  isAdmin,
}: {
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  agentId: string;
  isAdmin: boolean;
}) {
  const { data: catalog } = useQuery({
    queryKey: ['tool-templates'],
    queryFn: () => api<{ templates: ToolTemplateInfo[] }>('/api/tool-templates'),
    staleTime: 300_000,
  });
  // Template-installed tools are managed by the integration cards — the JSON
  // editor only ever sees custom actions. Name matching covers installs that
  // predate the `template` marker.
  const managedNames = new Set(
    (catalog?.templates ?? []).flatMap((t) => t.tools.map((x) => x.name)),
  );
  const isManaged = (t: NonNullable<AgentConfig['tools']>[number]) =>
    !!t.template || managedNames.has(t.name);
  const managedTools = (cfg.tools ?? []).filter(isManaged);
  const customTools = (cfg.tools ?? []).filter((t) => !isManaged(t));

  const [toolsJson, setToolsJson] = useState('');
  const [toolsError, setToolsError] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  // Populate the editor when it's opened — by then the catalog is loaded so
  // managed tools are correctly excluded. Reopening always reflects current
  // custom tools.
  useEffect(() => {
    if (!showCustom) return;
    setToolsJson(customTools.length ? JSON.stringify(customTools, null, 2) : '');
    setToolsError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCustom]);

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
      <ReadOnly off={!isAdmin}>
      <label>Integrations — services the agent can act in</label>
      <IntegrationCards
        cfg={cfg}
        setCfg={setCfg}
        agentId={agentId}
        customOpen={showCustom}
        onToggleCustom={() => setShowCustom((v) => !v)}
      />
      {showCustom && (
      <>
      <label>Custom API actions — the agent calls your backend: order lookups, refunds, subscription changes, bookings. {'{param}'} placeholders in the URL become arguments; "needs approval" parks a call for teammate sign-off.</label>
      {customTools.map((t) => (
        <div key={t.name} className="card" style={{ background: 'var(--panel-2)', padding: 10 }}>
          <div className="row">
            <span className="mono grow" style={{ fontSize: 13 }}>{t.name}</span>
            <span className="badge">{t.method}</span>
            {t.approval && <span className="badge warn">needs approval</span>}
            {isAdmin && (
              <button
                className="btn sm"
                title="Remove action"
                onClick={() =>
                  setCfg({
                    ...cfg,
                    tools: [...managedTools, ...customTools.filter((x) => x !== t)],
                  })
                }
                aria-label={`Remove tool ${t.name ?? t.url}`}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="muted mono" style={{ fontSize: 11, marginTop: 4, overflowWrap: 'anywhere' }}>
            {t.url}
          </div>
          {t.description && <div style={{ fontSize: 12, marginTop: 4 }}>{t.description}</div>}
        </div>
      ))}
      {isAdmin && (
        <CustomToolForm
          onAdd={(tool) =>
            setCfg({ ...cfg, tools: [...managedTools, ...customTools, tool] })
          }
        />
      )}
      <details>
        <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
          edit as JSON
        </summary>
        <textarea
          rows={12}
          className="mono"
          style={{ marginTop: 8, width: '100%', minHeight: 200, resize: 'vertical' }}
          placeholder={'[\n  {\n    "name": "lookup_order",\n    "description": "Look up an order in our POS by order number",\n    "method": "GET",\n    "url": "https://api.acme-pos.com/orders/{order_id}",\n    "headers": { "authorization": "Bearer {{secrets.POS_API_KEY}}" },\n    "params": { "order_id": "the order number the user gave" }\n  }\n]'}
          value={toolsJson}
          onChange={(e) => setToolsJson(e.target.value)}
          onBlur={() => {
            try {
              const parsed: NonNullable<AgentConfig['tools']> = toolsJson.trim()
                ? JSON.parse(toolsJson)
                : [];
              setCfg({ ...cfg, tools: [...managedTools, ...parsed] });
              setToolsError('');
            } catch {
              setToolsError('invalid JSON — not saved until it parses');
            }
          }}
        />
        {toolsError && <div className="error">{toolsError}</div>}
      </details>
      </>
      )}
      <label>
        Secrets — API credentials for tool calls; reference as{' '}
        <span className="mono">{'{{secrets.NAME}}'}</span> in tool URLs and headers
      </label>
      <Secrets agentId={agentId} />
      </ReadOnly>
    </div>
  );
}

/** Integration catalog — installs a template's tools and stores its
 *  credentials as agent secrets in one click. */
function IntegrationCards({
  cfg,
  setCfg,
  agentId,
  customOpen,
  onToggleCustom,
}: {
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  agentId: string;
  customOpen: boolean;
  onToggleCustom: () => void;
}) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['tool-templates'],
    queryFn: () => api<{ templates: ToolTemplateInfo[] }>('/api/tool-templates'),
    staleTime: 300_000,
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');

  const syncTools = (tools: AgentConfig['tools']) => setCfg({ ...cfg, tools });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
    void qc.invalidateQueries({ queryKey: ['secrets', agentId] });
  };

  const install = useMutation({
    mutationFn: (t: ToolTemplateInfo) =>
      api<{ agent: Agent }>(`/api/agents/${agentId}/tools/install`, {
        method: 'POST',
        body: JSON.stringify({ template: t.id, fields }),
      }),
    onSuccess: (r) => {
      syncTools(r.agent.config?.tools);
      invalidate();
      setOpenId(null);
      setFields({});
      setErr('');
    },
    onError: (e) => setErr(e.message),
  });
  const remove = useMutation({
    mutationFn: (t: ToolTemplateInfo) =>
      api<{ agent: Agent }>(`/api/agents/${agentId}/tools/${t.id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      syncTools(r.agent.config?.tools);
      invalidate();
    },
    onError: (e) => setErr(e.message),
  });

  const setApprovals = useMutation({
    mutationFn: ({ t, approvals }: { t: ToolTemplateInfo; approvals: Record<string, boolean> }) =>
      api<{ agent: Agent }>(`/api/agents/${agentId}/tools/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ approvals }),
      }),
    onSuccess: (r) => {
      syncTools(r.agent.config?.tools);
      invalidate();
    },
    onError: (e) => setErr(e.message),
  });

  const installed = (t: ToolTemplateInfo) => {
    const names = new Set((cfg.tools ?? []).map((x) => x.name));
    return t.tools.every((x) => names.has(x.name));
  };

  const templates = data?.templates ?? [];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
      {templates.map((t) => (
        <div key={t.id} className="card" style={{ padding: 14, margin: 0 }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <strong>{t.name}</strong>
            {t.auth === 'oauth' && <span className="badge">oauth</span>}
            <span className="badge" style={{ marginLeft: 'auto' }}>{t.category}</span>
          </div>
          <div className="muted" style={{ fontSize: 12, margin: '8px 0 10px' }}>{t.blurb}</div>
          {t.docs_url && (
            <a
              href={t.docs_url}
              target="_blank"
              rel="noreferrer"
              className="muted"
              style={{ fontSize: 11 }}
            >
              Setup guide ↗
            </a>
          )}
          {installed(t) ? (
            <div className="muted" style={{ fontSize: 11, margin: '0 0 10px', lineHeight: 1.9 }}>
              {t.tools.map((x) => {
                const live = (cfg.tools ?? []).find((o) => o.name === x.name);
                const gated = live ? !!live.approval : !!x.approval;
                return (
                  <label
                    key={x.name}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={gated}
                      disabled={setApprovals.isPending}
                      onChange={(e) =>
                        setApprovals.mutate({ t, approvals: { [x.name]: e.target.checked } })
                      }
                    />
                    <span>{x.label ?? x.name}</span>
                    {gated && <span className="badge">needs approval</span>}
                  </label>
                );
              })}
              <div style={{ fontSize: 11, marginTop: 4 }}>
                Checked = a teammate approves before it runs; unchecked = autonomous.
              </div>
            </div>
          ) : null}
          {openId === t.id ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {t.fields.map((f) => (
                <div key={f.key}>
                  <div style={{ fontSize: 13, marginBottom: 4 }}>{f.label}</div>
                  <input
                    style={{ width: '100%', boxSizing: 'border-box' }}
                    placeholder={f.placeholder ?? ''}
                    value={fields[f.key] ?? ''}
                    onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
                  />
                  {f.help && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
                      {f.help}
                    </div>
                  )}
                </div>
              ))}
              {err && <div className="error">{err}</div>}
              <div className="row" style={{ marginTop: 2 }}>
                <button
                  className="btn primary"
                  disabled={install.isPending || t.fields.some((f) => !fields[f.key]?.trim())}
                  onClick={() => install.mutate(t)}
                >
                  {install.isPending ? 'Connecting…' : 'Connect'}
                </button>
                <button className="btn" onClick={() => { setOpenId(null); setErr(''); }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ marginTop: 10 }}>
              <button
                className="btn"
                onClick={() =>
                  t.fields.length ? (setOpenId(t.id), setErr(''), setFields({})) : install.mutate(t)
                }
              >
                {installed(t) ? 'Update credentials' : 'Connect'}
              </button>
              {installed(t) && (
                <>
                  <span className="badge active">connected</span>
                  <button className="btn" onClick={() => remove.mutate(t)}>Remove</button>
                </>
              )}
            </div>
          )}
        </div>
      ))}
      <div className="card" style={{ padding: 14, margin: 0 }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <strong>Custom API action</strong>
          <span className="badge" style={{ marginLeft: 'auto' }}>JSON</span>
        </div>
        <div className="muted" style={{ fontSize: 12, margin: '8px 0 10px' }}>
          Call any API — describe the request as JSON. "approval": true gates it behind
          teammate sign-off.
        </div>
        <button className="btn" onClick={onToggleCustom}>
          {customOpen ? 'Hide editor' : 'Configure'}
        </button>
      </div>
    </div>
  );
}

/** Freshly minted secret shown inline where the button was clicked — copy
 *  now or lose it; only a prefix/suffix preview survives the save. */
function FreshSecretCard({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="card"
      style={{ borderColor: 'var(--accent)', marginTop: 8, marginBottom: 4 }}
    >
      <div className="muted" style={{ fontSize: 12 }}>
        {label} — copy it now, it won't be shown again:
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <div className="mono grow" style={{ overflowWrap: 'anywhere' }}>{value}</div>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function ConnectionTab({
  agent,
  cfg,
  setCfg,
  isAdmin,
  webhookUrl,
  setWebhookUrl,
  onSaveHosted,
  onTestWebhook,
  onRotateKey,
  onRotateSecret,
  onRevealSecret,
  freshSecret,
}: {
  agent: Agent;
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  isAdmin: boolean;
  webhookUrl: string;
  setWebhookUrl: (s: string) => void;
  onSaveHosted: (hosted: boolean) => void;
  onTestWebhook: () => void;
  onRotateKey: () => void;
  onRotateSecret: () => void;
  onRevealSecret: () => void;
  freshSecret: { label: string; value: string } | null;
}) {
  const navigate = useNavigate();
  const [testMsg, setTestMsg] = useState('');
  const [showDeliveries, setShowDeliveries] = useState(false);
  const { data: deliveries } = useDeliveries(showDeliveries ? agent.id : null);
  const qcLocal = useQueryClient();
  const replay = useMutation({
    mutationFn: (deliveryId: string) =>
      api(`/api/agents/${agent.id}/deliveries/${deliveryId}/replay`, { method: 'POST' }),
    onSettled: () => void qcLocal.invalidateQueries({ queryKey: ['deliveries'] }),
  });
  const onTestChat = async (text: string) => {
    const r = await api<{ conversation_id: string | null }>(`/api/agents/${agent.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (r.conversation_id) navigate(`/conversations/${r.conversation_id}`);
  };

  return (
    <>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <label style={{ margin: 0 }}>Runs</label>
          <select
            value={agent.hosted ? 'hosted' : 'external'}
            disabled={!isAdmin}
            onChange={(e) => onSaveHosted(e.target.value === 'hosted')}
          >
            <option value="hosted">Hosted by Janis — nothing to deploy</option>
            <option value="external">External webhook — you run the agent</option>
          </select>
        </div>
        {agent.hosted ? (
          <div className="muted">
            Janis runs this agent in-process with the config below — replies go
            straight to the connected channel. No webhook, no deploy.
            <form
              className="row"
              style={{ marginTop: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (!testMsg.trim()) return;
                void onTestChat(testMsg.trim());
                setTestMsg('');
              }}
            >
              <input
                className="grow"
                placeholder="Send a test message…"
                value={testMsg}
                onChange={(e) => setTestMsg(e.target.value)}
              />
              <button className="btn">Test</button>
            </form>
          </div>
        ) : (
          <>
            {!agent.webhook_url && !webhookUrl && (
              <div style={{ color: '#fde047', marginBottom: 8 }}>
                No webhook URL set — inbound messages on connected channels will be stored but go unanswered.
              </div>
            )}
            <label>Webhook URL (receives takeover + human messages, HMAC-signed)</label>
            <div className="row">
              <input
                className="grow"
                placeholder="https://your-agent.example.com/janis/webhook"
                value={webhookUrl}
                disabled={!isAdmin}
                onChange={(e) => setWebhookUrl(e.target.value)}
              />
              {isAdmin && (
                <button className="btn" onClick={onTestWebhook} disabled={!agent.webhook_url}>
                  Test
                </button>
              )}
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              Run the reference agent —{' '}
              <span className="mono">JANIS_API_KEY=… npx janis-agent</span>
              {' '}— full contract + quickstart in the{' '}
              <a href="/docs" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                self-hosting docs
              </a>
              . Working locally?{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setWebhookUrl(TEMPLATE_WEBHOOK);
                }}
              >
                point it at the local template
              </a>
              {' '}then Save.
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <strong>Credentials{agent.hosted ? '' : ' &amp; deliveries'}</strong>
        {freshSecret && (
          <FreshSecretCard label={freshSecret.label} value={freshSecret.value} />
        )}
        {agent.api_key_preview && (
          <div className="muted" style={{ marginTop: 6 }}>
            Active key: <span className="mono">{agent.api_key_preview}</span>
            {' '}— full key is shown once at creation and can't be recovered.
          </div>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          {isAdmin && (
            <>
              <button className="btn" onClick={onRotateKey}>
                {agent.api_key_preview ? 'Rotate API key' : 'Generate API key'}
              </button>
              {!agent.hosted && (
                <>
                  <button className="btn" onClick={onRotateSecret}>Rotate webhook secret</button>
                  <button className="btn" onClick={onRevealSecret}>Show webhook secret</button>
                </>
              )}
            </>
          )}
          {!agent.hosted && (
            <button className="btn" onClick={() => setShowDeliveries((s) => !s)}>
              {showDeliveries ? 'Hide deliveries' : 'Deliveries'}
            </button>
          )}
        </div>
        <div className="muted" style={{ marginTop: 8 }}>
          API keys authenticate the /v1 API — send replies, escalate, resolve,
          poll conversations — and the Janis app in Zapier. Send it as
          {' '}<span className="mono">X-API-KEY</span> or{' '}
          <span className="mono">Authorization: Bearer</span>.
        </div>
        {showDeliveries && (
          <div className="muted" style={{ marginTop: 10 }}>
            {deliveries?.deliveries.length === 0 && <div>No deliveries yet.</div>}
            {deliveries?.deliveries.map((d) => (
              <div key={d.id} style={{ marginTop: 4 }}>
                <div className="row">
                  <span className={`badge ${d.status === 'delivered' ? 'active' : 'needs_human'}`}>
                    {d.status}
                  </span>
                  <span className="mono">{d.type}</span>
                  <span className="grow">{d.last_error ?? ''}</span>
                  {d.attempts > 1 && <span>×{d.attempts}</span>}
                  <span>{timeAgo(d.created_at)}</span>
                  {isAdmin && d.status === 'failed' && (
                    <button className="btn" disabled={replay.isPending} onClick={() => replay.mutate(d.id)}>
                      Replay
                    </button>
                  )}
                </div>
                <details style={{ marginTop: 2 }}>
                  <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                    payload
                  </summary>
                  <pre style={{ fontSize: 11, overflow: 'auto', margin: '4px 0 0' }}>
                    {JSON.stringify(d.payload, null, 2)}
                  </pre>
                </details>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ---- shared subcomponents ---- */

/** Per-agent LLM override — empty llm block inherits the workspace default
 *  (Settings → Default LLM), which itself falls back to the env default. */
function LlmCard({
  agent,
  cfg,
  setCfg,
  isAdmin,
}: {
  agent: Agent;
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  isAdmin: boolean;
}) {
  const { data: ws } = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      api<{ workspace: { llm_config?: LlmBlock } }>('/api/workspace'),
  });
  const inherited = ws?.workspace.llm_config?.model || undefined;
  return (
    <div className="card" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label>LLM override</label>
      <div className="muted" style={{ fontSize: 12 }}>
        Overrides the workspace default (Settings → Default LLM). Leave the model
        unset to inherit.
      </div>
      <LlmEditor
        llm={(cfg.llm ?? {}) as LlmBlock}
        onChange={(l) => setCfg({ ...cfg, llm: l })}
        isAdmin={isAdmin}
        modelsUrl={`/api/agents/${agent.id}/llm-models`}
        inheritedModel={inherited}
        inheritedLabel="workspace default"
      />
    </div>
  );
}

interface KnowledgeFile {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  chars: number;
  status: string;
  error: string | null;
  source_url: string | null;
  refresh_hours: number | null;
  last_fetched_at: string | null;
  next_fetch_at: string | null;
  created_at: string;
}

function KnowledgeFiles({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['knowledge', agentId],
    queryFn: () => api<{ files: KnowledgeFile[] }>(`/api/agents/${agentId}/knowledge`),
  });
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    setError('');
    for (const f of Array.from(list)) {
      const form = new FormData();
      form.append('file', f);
      const res = await fetch(`/api/agents/${agentId}/knowledge`, {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(`${f.name}: ${body.error ?? `HTTP ${res.status}`}`);
        break;
      }
    }
    setUploading(false);
    void qc.invalidateQueries({ queryKey: ['knowledge', agentId] });
  };

  const [url, setUrl] = useState('');
  const [urlHours, setUrlHours] = useState(24);
  const [urlMode, setUrlMode] = useState<'page' | 'centre'>('page');
  const [importMsg, setImportMsg] = useState('');
  const addUrl = useMutation({
    mutationFn: () =>
      api(`/api/agents/${agentId}/knowledge-url`, {
        method: 'POST',
        body: JSON.stringify({ url: url.trim(), refresh_hours: urlHours }),
      }),
    onSuccess: () => {
      setUrl('');
      void qc.invalidateQueries({ queryKey: ['knowledge', agentId] });
    },
    onError: (e) => setError(e.message),
  });
  const importCentre = useMutation({
    mutationFn: () =>
      api<{ kind: string; imported: number; queued: number; skipped: number; discovered: number }>(
        `/api/agents/${agentId}/knowledge-import`,
        {
          method: 'POST',
          body: JSON.stringify({ url: url.trim(), refresh_hours: urlHours }),
        },
      ),
    onSuccess: (r) => {
      setUrl('');
      const dup = r.skipped ? ` (${r.skipped} already imported)` : '';
      setImportMsg(
        r.kind === 'zendesk'
          ? `Imported ${r.imported} article${r.imported === 1 ? '' : 's'} from the Zendesk API${dup} — they re-crawl on this schedule.`
          : `Found ${r.discovered} pages${dup} — ${r.queued} queued; the sweeper fetches them in batches.`,
      );
      void qc.invalidateQueries({ queryKey: ['knowledge', agentId] });
    },
    onError: (e) => setError(e.message),
  });
  const refresh = useMutation({
    mutationFn: (fileId: string) =>
      api(`/api/agents/${agentId}/knowledge/${fileId}/refresh`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['knowledge', agentId] }),
  });

  const remove = useMutation({
    mutationFn: (fileId: string) =>
      api(`/api/agents/${agentId}/knowledge/${fileId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['knowledge', agentId] }),
  });

  return (
    <div>
      {(data?.files ?? []).map((f) => (
        <div key={f.id} className="row muted" style={{ marginTop: 6 }}>
          <span className="grow">
            {f.source_url ? '🔗' : '📄'} {f.name}
            <span className="muted">
              {' '}— {Math.max(1, Math.round(f.size_bytes / 1024))}KB → {f.chars.toLocaleString()} chars
            </span>
            {f.source_url && (
              <span className="muted">
                {' '}· fetched {f.last_fetched_at ? timeAgo(f.last_fetched_at) : 'never'}
                {f.refresh_hours ? ` · re-checks every ${f.refresh_hours}h` : ''}
              </span>
            )}
            {f.status === 'failed' && <span className="error"> {f.error}</span>}
          </span>
          {f.source_url && (
            <button
              className="btn sm"
              title="Re-crawl now"
              aria-label="Re-crawl now"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate(f.id)}
            >
              <RefreshCw size={13} className={refresh.isPending ? 'spin-ic' : ''} />
            </button>
          )}
          <button className="btn danger" onClick={() => remove.mutate(f.id)} aria-label="Delete file"><Trash2 size={14} /></button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <input
          type="file"
          multiple
          disabled={uploading}
          accept=".pdf,.docx,.txt,.md,.csv,.json,.xml,.html,.log,.yaml,.yml,.png,.jpg,.jpeg,.webp,.gif"
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = '';
          }}
        />
        {uploading && <span className="muted">extracting…</span>}
      </div>
      <div className="muted" style={{ marginTop: 12, fontSize: 13 }}>
        Or keep a live web source — re-crawled on the schedule you pick:
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input
          className="grow"
          placeholder={
            urlMode === 'page'
              ? 'A single page — e.g. https://acme.com/faq'
              : 'A help centre root — e.g. https://acme.zendesk.com (add /hc/en-us to scope a locale)'
          }
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <select
          value={urlMode}
          onChange={(e) => setUrlMode(e.target.value as 'page' | 'centre')}
          title="What to import"
        >
          <option value="page">Single page</option>
          <option value="centre">Whole help centre</option>
        </select>
        <select
          value={urlHours}
          onChange={(e) => setUrlHours(Number(e.target.value))}
          title="How often it re-crawls"
        >
          <option value={1}>every hour</option>
          <option value={24}>daily</option>
          <option value={168}>weekly</option>
        </select>
        <button
          className="btn sm"
          disabled={!url.trim() || addUrl.isPending || importCentre.isPending}
          onClick={() => (urlMode === 'page' ? addUrl : importCentre).mutate()}
        >
          {addUrl.isPending ? 'Fetching…' : importCentre.isPending ? 'Importing…' : 'Add'}
        </button>
      </div>
      <div className="muted" style={{ marginTop: 4, fontSize: 12.5 }}>
        {urlMode === 'page'
          ? 'Fetches this one page now and re-crawls it on the cadence — good for a pricing or FAQ page that changes.'
          : 'Imports every article it finds: Zendesk help centres use their API directly; any other site is discovered via its sitemap. Each article becomes its own re-crawled source.'}
      </div>
      {importMsg && <div className="muted" style={{ marginTop: 4 }}>{importMsg}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

interface Gap {
  key: string;
  count: number;
  questions: string[];
  resolutions: string[];
  conversation_ids: string[];
  last_seen: string;
  added: boolean;
  handled: string[];
}

interface Learning {
  key: string;
  text: string;
  conversation_id: string;
  last_seen: string;
  added: boolean;
}

/** Recurring handoff clusters + agent self-reported gaps → draft → approve
 * into the knowledge base. */
function KnowledgeGaps({ agentId, config }: { agentId: string; config: AgentConfig }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['knowledge-gaps', agentId],
    queryFn: () =>
      api<{ gaps: Gap[]; learnings: Learning[]; computed_at?: string }>(`/api/agents/${agentId}/knowledge-gaps`),
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [learnEdits, setLearnEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const dismiss = useMutation({
    mutationFn: (v: {
      field: 'dismissed_learnings' | 'dismissed_gaps';
      keys: string[];
    }) => {
      const now = new Date().toISOString();
      return api(`/api/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          config: {
            ...config,
            [v.field]: [...new Set([...(config[v.field] ?? []), ...v.keys])],
            // gaps get dismissal timestamps — they may legitimately resurface
            // if the question escalates AGAIN after the dismissal
            ...(v.field === 'dismissed_gaps'
              ? {
                  dismissed_gap_times: {
                    ...(config.dismissed_gap_times ?? {}),
                    ...Object.fromEntries(v.keys.map((k) => [k, now])),
                  },
                }
              : {}),
          },
        }),
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agents'] }),
    onError: (e) => setError(e.message),
  });
  // Detection is cached server-side — Refresh is the explicit recompute.
  const refresh = useMutation({
    mutationFn: () =>
      api(`/api/agents/${agentId}/knowledge-gaps/refresh`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['knowledge-gaps', agentId] }),
    onError: (e) => setError(e.message),
  });
  const recheck = useMutation({
    mutationFn: () =>
      api<{ covered: string[] }>(`/api/agents/${agentId}/knowledge-gaps/recheck`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['knowledge-gaps', agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (e) => setError(e.message),
  });

  const draft = useMutation({
    mutationFn: (g: Gap) =>
      api<{ draft: string }>(`/api/agents/${agentId}/knowledge-gaps/draft`, {
        method: 'POST',
        body: JSON.stringify({ questions: g.questions, resolutions: g.resolutions }),
      }),
    onSuccess: (d, g) => setDrafts((s) => ({ ...s, [g.key]: d.draft })),
    onError: (e) => setError(e.message),
  });
  const approve = useMutation({
    mutationFn: (v: { key: string; entry: string }) =>
      api(`/api/agents/${agentId}/knowledge-gaps`, {
        method: 'POST',
        body: JSON.stringify({ entry: v.entry }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['knowledge-gaps', agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (e) => setError(e.message),
  });

  const dismissedL = new Set(config.dismissed_learnings ?? []);
  const dismissedG = new Set(config.dismissed_gaps ?? []);
  const dismissTimes = config.dismissed_gap_times ?? {};
  const gapKey = (q: string) => q.toLowerCase().slice(0, 60);
  // A dismissed cluster stays hidden until it escalates AGAIN after the
  // dismissal — a new phrasing of the same question doesn't resurface it, a
  // new occurrence does. Entries without a timestamp (pre-timestamp
  // dismissals) stay hidden permanently.
  const gapDismissed = (g: Gap) => {
    const covered =
      dismissedG.has(g.key) ||
      (g.questions.length > 0 && g.questions.every((q) => dismissedG.has(gapKey(q))));
    if (!covered) return false;
    const times = [g.key, ...g.questions.map(gapKey)]
      .map((k) => dismissTimes[k])
      .filter((t): t is string => !!t)
      .map((t) => Date.parse(t))
      .filter(Number.isFinite);
    if (!times.length) return true; // legacy dismissal — never resurface
    return Date.parse(g.last_seen) <= Math.max(...times);
  };
  const gaps = (data?.gaps ?? []).filter((g) => !gapDismissed(g));
  const learnings = (data?.learnings ?? []).filter((l) => !dismissedL.has(l.key));
  const [page, setPage] = useState(0);
  const PAGE = 5;
  const pageCount = Math.max(1, Math.ceil(gaps.length / PAGE));
  const pageGaps = gaps.slice(Math.min(page, pageCount - 1) * PAGE, (Math.min(page, pageCount - 1) + 1) * PAGE);
  return (
    <div className="form-section">
      <div className="row">
        <strong className="grow">Knowledge gaps</strong>
        {data?.computed_at && (
          <span className="muted" style={{ fontSize: 12 }}>detected {timeAgo(data.computed_at)}</span>
        )}
        <button className="btn" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? 'Detecting…' : 'Refresh'}
        </button>
        {gaps.length > 0 && (
          <button className="btn" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
            {recheck.isPending ? 'Checking…' : 'Re-check resolved'}
          </button>
        )}
      </div>
      {!data ? (
        <div className="muted" style={{ marginTop: 10 }}>Detecting knowledge gaps…</div>
      ) : !gaps.length ? (
        <div className="muted" style={{ marginTop: 10 }}>
          No recurring gaps — nothing has escalated to a human twice in the last 30 days.
        </div>
      ) : (
        <span className="muted"> — {gaps.length} recurring question{gaps.length > 1 ? 's' : ''} the agent couldn't answer</span>
      )}
      {recheck.data && (
        <div className="muted" style={{ marginTop: 6 }}>
          re-check: {recheck.data.covered.length ? `${recheck.data.covered.length} cluster(s) now covered — dismissed` : 'none covered yet'}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        {gaps.length > 0 && (
          <div className="muted" style={{ marginBottom: 10 }}>
            These questions triggered handoffs more than once in the last 30 days. Draft an
            answer, edit it, and add it to the knowledge base — nothing changes the agent
            until you approve it.
          </div>
        )}
        {error && <div className="error" style={{ marginBottom: 8 }}>{error}</div>}
        {pageGaps.map((g) => (
          <div key={g.key} className="card" style={{ marginBottom: 10, padding: 12 }}>
            <div className="row">
              <strong className="grow">{g.questions[0]}</strong>
              <span className="badge needs_human">{g.count}×</span>
              {g.added && <span className="badge active">in knowledge base</span>}
            </div>
            {g.questions.length > 1 && (
              <div className="muted" style={{ marginTop: 4 }}>
                also: {g.questions.slice(1, 3).join(' · ')}
              </div>
            )}
            {g.resolutions.length > 0 && (
              <div className="muted" style={{ marginTop: 4 }}>
                resolved by a human: “{g.resolutions[0].slice(0, 140)}”
              </div>
            )}
            {g.handled.length > 0 && (
              <div className="muted" style={{ marginTop: 4 }}>
                agent has since answered similar: {g.handled.join(' · ')}
              </div>
            )}
            <div className="muted" style={{ marginTop: 4 }}>last seen {timeAgo(g.last_seen)}</div>
            {!g.added && (
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  className="btn"
                  disabled={draft.isPending}
                  onClick={() => draft.mutate(g)}
                >
                  {drafts[g.key] ? 'Re-draft' : 'Draft answer'}
                </button>
                {drafts[g.key] && (
                  <button
                    className="btn primary"
                    disabled={approve.isPending || !drafts[g.key].trim()}
                    onClick={() => approve.mutate({ key: g.key, entry: drafts[g.key] })}
                  >
                    Add to knowledge base
                  </button>
                )}
              </div>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn"
                disabled={dismiss.isPending}
                onClick={() =>
                  dismiss.mutate({
                    field: 'dismissed_gaps',
                    keys: [g.key, ...g.questions.map(gapKey)],
                  })
                }
              >
                {g.added ? 'Dismiss (already in knowledge base)' : 'Dismiss'}
              </button>
            </div>
            {drafts[g.key] && !g.added && (
              <textarea
                rows={6}
                style={{ marginTop: 8, width: '100%', boxSizing: 'border-box' }}
                value={drafts[g.key]}
                onChange={(e) => setDrafts((s) => ({ ...s, [g.key]: e.target.value }))}
              />
            )}
          </div>
        ))}
        {pageCount > 1 && (
          <div className="row" style={{ marginTop: 4 }}>
            <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              ← Prev
            </button>
            <span className="muted">
              page {Math.min(page, pageCount - 1) + 1} of {pageCount}
            </span>
            <button
              className="btn"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        )}
        {learnings.length > 0 && (
          <div className="muted" style={{ margin: '14px 0 8px' }}>
            The agent flagged these itself — facts it was missing mid-conversation.
            Edit and approve to teach it.
          </div>
        )}
        {learnings.map((l) => (
          <div key={l.key} className="card" style={{ marginBottom: 10, padding: 12 }}>
            <div className="row">
              <strong className="grow">{l.text}</strong>
              {l.added && <span className="badge active">in knowledge base</span>}
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              self-reported · last seen {timeAgo(l.last_seen)}
            </div>
            {!l.added && (
              <>
                <textarea
                  rows={4}
                  style={{ marginTop: 8, width: '100%', boxSizing: 'border-box' }}
                  value={learnEdits[l.key] ?? l.text}
                  onChange={(e) =>
                    setLearnEdits((s) => ({ ...s, [l.key]: e.target.value }))
                  }
                />
                <div className="row" style={{ marginTop: 8 }}>
                  <button
                    className="btn primary"
                    disabled={approve.isPending || !(learnEdits[l.key] ?? l.text).trim()}
                    onClick={() =>
                      approve.mutate({ key: l.key, entry: (learnEdits[l.key] ?? l.text).trim() })
                    }
                  >
                    Add to knowledge base
                  </button>
                  <button
                    className="btn"
                    disabled={dismiss.isPending}
                    onClick={() =>
                      dismiss.mutate({ field: 'dismissed_learnings', keys: [l.key] })
                    }
                  >
                    Dismiss
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Secrets({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['secrets', agentId],
    queryFn: () => api<{ secrets: AgentSecretMeta[] }>(`/api/agents/${agentId}/secrets`),
  });
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api(`/api/agents/${agentId}/secrets`, {
        method: 'PUT',
        body: JSON.stringify({ name: name.trim(), value }),
      }),
    onSuccess: () => {
      setName('');
      setValue('');
      setError('');
      void qc.invalidateQueries({ queryKey: ['secrets', agentId] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'failed'),
  });

  const remove = useMutation({
    mutationFn: (n: string) =>
      api(`/api/agents/${agentId}/secrets/${encodeURIComponent(n)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['secrets', agentId] }),
  });

  return (
    <div>
      {(data?.secrets ?? []).map((s) => (
        <div key={s.name} className="row muted" style={{ marginTop: 6 }}>
          <span className="grow mono">
            🔒 {s.name} <span className="muted">— •••••••• (write-only)</span>
          </span>
          <button className="btn danger" onClick={() => remove.mutate(s.name)} aria-label={`Delete secret ${s.name}`}><Trash2 size={14} /></button>
        </div>
      ))}
      <form
        className="row"
        style={{ marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && value) save.mutate();
        }}
      >
        <input
          className="mono"
          style={{ width: 190 }}
          placeholder="NAME (e.g. POS_API_KEY)"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
        />
        <input
          className="grow"
          type="password"
          placeholder="value — stored encrypted, never shown again"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="new-password"
        />
        <button className="btn" disabled={save.isPending || !name.trim() || !value}>
          {save.isPending ? 'Saving…' : 'Add'}
        </button>
      </form>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

// ── Regression tests — real transcripts replayed against current config ──

interface AgentTestRun {
  at: string;
  passed: boolean | null;
  reason: string;
  reply: string | null;
  control?: 'handoff' | 'offer' | 'cancel';
  tools?: { name: string; gated?: boolean; outcome: string }[];
  model?: string;
  context?: { prompt: 'custom' | 'default'; kb: string[]; knowledge: string[] };
}

interface AgentTest {
  id: string;
  name: string;
  turns: { role: 'customer' | 'agent'; text: string; mid?: string }[];
  expectation: string;
  /** Expectation was AI-drafted at save time and not yet reviewed. */
  expectation_draft?: boolean;
  source_conversation_id?: string | null;
  source_message_id?: string | null;
  original_reply?: string | null;
  last_run?: AgentTestRun | null;
  created_at: string;
}

interface EvalBatch {
  batch_id: string;
  kind: 'manual' | 'ab' | 'scheduled';
  at: string;
  passed: number;
  failed: number;
  unrunnable: number;
  results: { test_id: string; name: string; passed: boolean | null; reason: string; model: string | null }[];
}

function TestsTab({ agentId, agent, isAdmin }: { agentId: string; agent: Agent; isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['agent-tests', agentId],
    queryFn: () => api<{ tests: AgentTest[] }>(`/api/agents/${agentId}/tests`),
  });
  const { data: runsData } = useQuery({
    queryKey: ['agent-test-runs', agentId],
    queryFn: () => api<{ batches: EvalBatch[] }>(`/api/agents/${agentId}/test-runs`),
  });
  // Rescued conversations with no saved test — the suggestion list turns
  // "a human had to step in" into the raw material for regression coverage.
  const { data: suggestionsData } = useQuery({
    queryKey: ['test-suggestions', agentId],
    queryFn: () =>
      api<{
        suggestions: {
          conversation_id: string;
          name: string;
          preview: string | null;
          rescues: number;
          last_rescue: string;
        }[];
      }>(`/api/agents/${agentId}/test-suggestions`),
  });
  const [running, setRunning] = useState<string | 'all' | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMsg, setNewMsg] = useState('');
  const [newExpectation, setNewExpectation] = useState('');
  const [err, setErr] = useState('');

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['agent-tests', agentId] });

  const runOne = useMutation({
    mutationFn: (testId: string) =>
      api(`/api/agents/${agentId}/tests/${testId}/run`, { method: 'POST' }),
    onSuccess: invalidate,
    onError: (e) => setErr(e.message),
    onSettled: () => setRunning(null),
  });
  const runAll = useMutation({
    mutationFn: () => api(`/api/agents/${agentId}/tests-run-all`, { method: 'POST' }),
    onSuccess: invalidate,
    onError: (e) => setErr(e.message),
    onSettled: () => setRunning(null),
  });
  // Prompt A/B — replay the whole suite against a candidate system prompt.
  // Nothing saves back to the agent; the summary is compared to the baseline
  // pass count shown on the tests list.
  const [abOpen, setAbOpen] = useState(false);
  const [candidatePrompt, setCandidatePrompt] = useState('');
  const [candidateModel, setCandidateModel] = useState('');
  const [abResult, setAbResult] = useState<{
    summary: { passed: number; failed: number; unrunnable: number };
    results: { name: string; passed: boolean | null; reason: string }[];
  } | null>(null);
  const abRun = useMutation({
    mutationFn: () =>
      api(`/api/agents/${agentId}/tests-run-all`, {
        method: 'POST',
        body: JSON.stringify({
          ...(candidatePrompt.trim() ? { system_prompt: candidatePrompt } : {}),
          ...(candidateModel.trim() ? { model: candidateModel.trim() } : {}),
        }),
      }),
    onSuccess: (r) => setAbResult(r as typeof abResult),
    onError: (e) => setErr(e.message),
    onSettled: () => setRunning(null),
  });
  const [importOpen, setImportOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const importCsv = useMutation({
    mutationFn: () =>
      api(`/api/agents/${agentId}/tests-import`, {
        method: 'POST',
        body: JSON.stringify({ csv: csvText }),
      }),
    onSuccess: () => {
      setImportOpen(false);
      setCsvText('');
      invalidate();
    },
    onError: (e) => setErr(e.message),
  });
  const del = useMutation({
    mutationFn: (testId: string) =>
      api(`/api/agents/${agentId}/tests/${testId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (e) => setErr(e.message),
  });
  const delGroup = useMutation({
    mutationFn: (sourceConvId: string) =>
      api(`/api/agents/${agentId}/tests?source=${sourceConvId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (e) => setErr(e.message),
  });
  // Edit state for the inline expectation textarea on each test card.
  const [editExp, setEditExp] = useState<{ id: string; text: string } | null>(null);
  const saveExp = useMutation({
    mutationFn: (b: { id: string; text: string }) =>
      api(`/api/agents/${agentId}/tests/${b.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectation: b.text }),
      }),
    onSuccess: () => {
      setEditExp(null);
      invalidate();
    },
    onError: (e) => setErr(e.message),
  });
  const create = useMutation({
    mutationFn: () =>
      api(`/api/agents/${agentId}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(),
          expectation: newExpectation.trim(),
          turns: [{ role: 'customer', text: newMsg.trim() }],
        }),
      }),
    onSuccess: () => {
      setNewOpen(false);
      setNewName('');
      setNewMsg('');
      setNewExpectation('');
      invalidate();
    },
    onError: (e) => setErr(e.message),
  });

  // Scheduled suite runs — eval_interval_hours in the agent config; the
  // sweeper enqueues eval.run jobs and alerts the workspace on regressions.
  const setSchedule = useMutation({
    mutationFn: (hours: number) => {
      const config = { ...(agent.config ?? {}) } as AgentConfig;
      if (hours) config.eval_interval_hours = hours;
      else delete config.eval_interval_hours;
      return api(`/api/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ config }),
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agents'] }),
    onError: (e) => setErr(e.message),
  });

  // "Save as tests" on a suggestion — POST /:id/tests with conversation_id
  // runs the checkpoint split (one test per rescue point) server-side.
  const saveSuggestion = useMutation({
    mutationFn: (s: { conversation_id: string; name: string }) =>
      api(`/api/agents/${agentId}/tests`, {
        method: 'POST',
        body: JSON.stringify({ name: `${s.name} — rescue`, conversation_id: s.conversation_id }),
      }),
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['test-suggestions', agentId] });
    },
    onError: (e) => setErr(e.message),
  });
  const dismissSuggestion = useMutation({
    mutationFn: (convId: string) => {
      const config = { ...(agent.config ?? {}) } as AgentConfig;
      config.dismissed_test_suggestions = [
        ...(config.dismissed_test_suggestions ?? []),
        convId,
      ];
      return api(`/api/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ config }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['test-suggestions', agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (e) => setErr(e.message),
  });

  const tests = data?.tests ?? [];
  const passed = tests.filter((t) => t.last_run?.passed === true).length;
  const failed = tests.filter((t) => t.last_run?.passed === false).length;
  const batches = runsData?.batches ?? [];
  const suggestions = suggestionsData?.suggestions ?? [];

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
      <ReadOnly off={!isAdmin}>
      <div className="row">
        <label className="grow" style={{ margin: 0 }}>
          Regression tests — saved conversations replayed against this agent's current setup
        </label>
        {tests.length > 0 && (
          <button
            className="btn sm"
            disabled={running !== null}
            onClick={() => { setRunning('all'); runAll.mutate(); }}
          >
            {running === 'all' ? 'Running…' : 'Run all'}
          </button>
        )}
        {tests.length > 0 && (
          <button
            className="btn sm"
            disabled={running !== null}
            onClick={() => { setAbOpen((v) => !v); }}
          >
            A/B prompt
          </button>
        )}
        <button className="btn sm" onClick={() => setImportOpen((v) => !v)}>
          Import CSV
        </button>
        <button className="btn sm" onClick={() => setNewOpen((v) => !v)}>
          + New test
        </button>
        {tests.length > 0 && (
          <label
            className="row"
            style={{ gap: 6, marginLeft: 'auto', fontSize: 12, whiteSpace: 'nowrap' }}
            title="Replay the suite on a schedule — the workspace is alerted when a run regresses"
          >
            <span className="muted">Auto-run</span>
            <select
              value={agent.config?.eval_interval_hours ?? 0}
              disabled={setSchedule.isPending}
              onChange={(e) => setSchedule.mutate(Number(e.target.value))}
            >
              <option value={0}>off</option>
              <option value={6}>every 6h</option>
              <option value={24}>daily</option>
              <option value={168}>weekly</option>
            </select>
          </label>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Save a transcript from any conversation ("Save as test") — each point where a
        human had to step in becomes its own test — then replay after prompt,
        knowledge, or tool changes. Replays never message customers and never execute tools —
        gated actions are only proposed. Add an expectation and each run is judged against it.
        {tests.length > 0 && (
          <span>
            {' '}
            · <span style={{ color: 'var(--accent)' }}>{passed} passing</span>
            {failed > 0 && <span style={{ color: 'var(--danger)' }}> · {failed} failing</span>}
          </span>
        )}
      </div>
      {suggestions.length > 0 && (
        <div className="card" style={{ padding: '12px 16px' }}>
          <div className="section-label" style={{ marginBottom: 4 }}>
            Rescued — not yet covered by a test
          </div>
          {suggestions.map((s) => (
            <div
              key={s.conversation_id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 0',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <Link
                  to={`/conversations/${s.conversation_id}`}
                  style={{ fontSize: 13, fontWeight: 500 }}
                >
                  {s.name}
                </Link>
                <div
                  className="muted"
                  style={{
                    fontSize: 12,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {s.rescues > 1 ? `${s.rescues} rescues` : 'rescued'} ·{' '}
                  {timeAgo(s.last_rescue)}
                  {s.preview ? ` · ${s.preview}` : ''}
                </div>
              </div>
              <ReadOnly off={!isAdmin}>
                <button
                  className="btn sm"
                  onClick={() =>
                    saveSuggestion.mutate({
                      conversation_id: s.conversation_id,
                      name: s.name,
                    })
                  }
                  disabled={saveSuggestion.isPending}
                >
                  Save as tests
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => dismissSuggestion.mutate(s.conversation_id)}
                  disabled={dismissSuggestion.isPending}
                >
                  dismiss
                </button>
              </ReadOnly>
            </div>
          ))}
        </div>
      )}
      {err && <div className="error">{err}</div>}

      {importOpen && (
        <div className="card" style={{ background: 'var(--panel-2)' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            One test per line: <code>name, customer message, expectation</code>. Paste from a
            spreadsheet or export. Multi-turn tests still come from "Save as test" on a conversation.
          </div>
          <textarea
            rows={6}
            placeholder={'name, prompt, expectation\nrefund request, "I want my money back", "Never promises a refund; offers human follow-up"'}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            style={{ width: '100%', fontFamily: 'monospace' }}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn primary sm"
              disabled={!csvText.trim() || importCsv.isPending}
              onClick={() => importCsv.mutate()}
            >
              {importCsv.isPending ? 'Importing…' : 'Import tests'}
            </button>
            <button className="btn sm" onClick={() => setImportOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {abOpen && (
        <div className="card" style={{ background: 'var(--panel-2)' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Paste a candidate system prompt and/or model id — the whole suite replays
            against it and reports pass/fail per test. Nothing changes until you copy
            the winner into the Engine / Language Model tab.
          </div>
          <textarea
            rows={6}
            placeholder="Candidate system prompt… (optional)"
            value={candidatePrompt}
            onChange={(e) => setCandidatePrompt(e.target.value)}
            style={{ width: '100%', fontFamily: 'monospace' }}
          />
          <input
            placeholder="Candidate model id — e.g. gpt-4o-mini (optional)"
            value={candidateModel}
            onChange={(e) => setCandidateModel(e.target.value)}
            style={{ marginTop: 8 }}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn primary sm"
              disabled={(!candidatePrompt.trim() && !candidateModel.trim()) || running !== null}
              onClick={() => { setRunning('all'); setAbResult(null); abRun.mutate(); }}
            >
              {running === 'all' ? 'Running…' : 'Run suite vs candidate'}
            </button>
            <button className="btn sm" onClick={() => setAbOpen(false)}>Close</button>
          </div>
          {abResult && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              <strong>
                Candidate: {abResult.summary.passed} passed, {abResult.summary.failed} failed
                {abResult.summary.unrunnable > 0 && `, ${abResult.summary.unrunnable} unrunnable`}
              </strong>
              <span className="muted"> (baseline: {passed} passing)</span>
              {abResult.results.filter((r) => r.passed === false).map((r) => (
                <div key={r.name} className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  ✗ {r.name} — {r.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {newOpen && (
        <div className="card" style={{ background: 'var(--panel-2)' }}>
          <input
            placeholder="Test name — e.g. angry refund request"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ width: '100%', marginBottom: 8 }}
          />
          <textarea
            rows={2}
            placeholder="Customer message — what the customer says"
            value={newMsg}
            onChange={(e) => setNewMsg(e.target.value)}
            style={{ width: '100%', marginBottom: 8 }}
          />
          <textarea
            rows={2}
            placeholder="Expectation — what a good reply does (judged by AI each run)"
            value={newExpectation}
            onChange={(e) => setNewExpectation(e.target.value)}
            style={{ width: '100%' }}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn primary sm"
              disabled={!newName.trim() || !newMsg.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Saving…' : 'Create test'}
            </button>
            <button className="btn sm" onClick={() => setNewOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {tests.length === 0 && !newOpen && (
        <div className="muted" style={{ fontSize: 13 }}>
          No tests yet. Open a conversation — especially one a human had to rescue — and hit
          "Save as test" to lock in what a good reply looks like.
        </div>
      )}

      {(() => {
        const renderTest = (t: AgentTest) => {
          const run = t.last_run;
          const open = expanded === t.id;
          return (
          <div key={t.id} className="card" style={{ background: 'var(--panel-2)', padding: 12 }}>
            <div className="row">
              <button
                className="btn sm"
                disabled={running !== null}
                onClick={() => { setRunning(t.id); runOne.mutate(t.id); }}
              >
                {running === t.id ? 'Running…' : '▶ Run'}
              </button>
              <span className="grow" style={{ fontWeight: 600 }}>{t.name}</span>
              {run && (
                <span
                  className={`badge ${run.passed === true ? 'active' : run.passed === false ? 'warn' : ''}`}
                  title={run.reason}
                >
                  {run.passed === true ? '✓ pass' : run.passed === false ? '✗ fail' : 'ran'}
                </span>
              )}
              {isAdmin && (
                <button
                  className="btn sm"
                  title="Delete test"
                  aria-label="Delete test"
                  onClick={() => del.mutate(t.id)}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            {(() => {
              const lastCustomer = [...t.turns].reverse().find((x) => x.role === 'customer');
              return lastCustomer ? (
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  responds to: "{lastCustomer.text.length > 90 ? `${lastCustomer.text.slice(0, 90)}…` : lastCustomer.text}"
                </div>
              ) : null;
            })()}
            {editExp?.id === t.id ? (
              <div style={{ marginTop: 6 }}>
                <textarea
                  rows={2}
                  autoFocus
                  style={{ width: '100%', fontSize: 12 }}
                  value={editExp.text}
                  onChange={(e) => setEditExp({ id: t.id, text: e.target.value })}
                />
                <div className="row" style={{ marginTop: 4 }}>
                  <button
                    className="btn primary sm"
                    disabled={saveExp.isPending}
                    onClick={() => saveExp.mutate({ id: t.id, text: editExp.text.trim() })}
                  >
                    {saveExp.isPending ? 'Saving…' : 'Save expectation'}
                  </button>
                  <button className="btn sm" onClick={() => setEditExp(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {t.expectation ? (
                  <>
                    expects: {t.expectation}
                    {t.expectation_draft && (
                      <span className="badge warn" style={{ marginLeft: 6 }} title="Written by AI at save time — review it">
                        AI draft
                      </span>
                    )}
                  </>
                ) : (
                  "no expectation — runs aren't judged"
                )}
                {isAdmin && (
                  <button
                    className="btn ghost sm"
                    style={{ marginLeft: 8 }}
                    onClick={() => setEditExp({ id: t.id, text: t.expectation })}
                  >
                    {t.expectation ? 'edit' : 'add one'}
                  </button>
                )}
              </div>
            )}
            {run && (
              <div style={{ fontSize: 12, marginTop: 6 }}>
                {run.reason && <div className="muted">{run.reason}</div>}
                {(run.reply || (run.tools?.length ?? 0) > 0) && (
                  <>
                    <button
                      className="inspector-toggle"
                      style={{ marginTop: 4 }}
                      onClick={() => setExpanded(open ? null : t.id)}
                    >
                      {open ? '▾ hide replay' : '▸ show replay'}
                    </button>
                    {open && (
                      <div className="inspector-panel" style={{ maxWidth: '100%', marginTop: 6 }}>
                        {/* The replay answers the last customer turn — show the
                            transcript tail so the reply has visible context. */}
                        {(() => {
                          const shown = t.turns.slice(-4);
                          const omitted = t.turns.length - shown.length;
                          return (
                            <>
                              {omitted > 0 && (
                                <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                                  …{omitted} earlier turn{omitted === 1 ? '' : 's'} in the replayed transcript
                                </div>
                              )}
                              {shown.map((turn, i) => {
                                const trigger = i === shown.length - 1 && turn.role === 'customer';
                                const linked = turn.mid && t.source_conversation_id;
                                return (
                                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 3, fontSize: 12 }}>
                                    <span
                                      className="mono muted"
                                      style={{ minWidth: 58, flexShrink: 0, fontSize: 11 }}
                                    >
                                      {turn.role}
                                    </span>
                                    {linked ? (
                                      <Link
                                        to={`/conversations/${t.source_conversation_id}?msg=${turn.mid}`}
                                        className={trigger ? '' : 'muted'}
                                        style={{
                                          ...(trigger ? { fontWeight: 600 } : {}),
                                          textDecoration: 'underline',
                                          textDecorationStyle: 'dotted',
                                          textUnderlineOffset: 3,
                                          whiteSpace: 'pre-wrap',
                                        }}
                                        title="Open this message in the conversation"
                                      >
                                        {turn.text}
                                      </Link>
                                    ) : (
                                      <span
                                        className={trigger ? '' : 'muted'}
                                        style={{ whiteSpace: 'pre-wrap', ...(trigger ? { fontWeight: 600 } : {}) }}
                                      >
                                        {turn.text}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                              {t.original_reply && (
                                <>
                                  <div
                                    className="muted"
                                    style={{ fontSize: 11, margin: '6px 0 3px' }}
                                  >
                                    ↳ original reply — what the agent actually did then:
                                  </div>
                                  <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>
                                    {t.original_reply}
                                  </div>
                                </>
                              )}
                              <div
                                className="muted"
                                style={{ fontSize: 11, margin: '6px 0 3px' }}
                              >
                                ↳ replayed now — current setup (never sent, tools stubbed):
                              </div>
                              {run.reply ? (
                                <div style={{ whiteSpace: 'pre-wrap' }}>{run.reply}</div>
                              ) : (
                                <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>
                                  (no text reply — the replay ended on tool calls, above)
                                </div>
                              )}
                            </>
                          );
                        })()}
                        {run.control && (
                          <div className="muted" style={{ marginTop: 6 }}>
                            ended with [{run.control === 'handoff' ? 'HANDOFF' : run.control === 'offer' ? 'OFFER_HUMAN' : 'CANCEL_HANDOFF'}]
                          </div>
                        )}
                        {run.tools?.length ? (
                          <div className="muted" style={{ marginTop: 6 }}>
                            tools: {run.tools.map((x) => `${x.name} (${x.outcome})`).join(', ')}
                          </div>
                        ) : null}
                        {run.model && (
                          <div className="muted" style={{ marginTop: 6 }}>model: {run.model}</div>
                        )}
                        {run.context && (
                          <div className="muted" style={{ marginTop: 6 }}>
                            grounded on: {run.context.prompt} prompt
                            {run.context.knowledge.length > 0 &&
                              ` · ${run.context.knowledge.length} knowledge snippet${run.context.knowledge.length === 1 ? '' : 's'}`}
                            {run.context.kb.length > 0 && ` · ${run.context.kb.join(', ')}`}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {t.source_conversation_id && (
              <div style={{ marginTop: 6 }}>
                <Link
                  to={`/conversations/${t.source_conversation_id}${t.source_message_id ? `?msg=${t.source_message_id}` : ''}`}
                  className="muted"
                  style={{ fontSize: 12 }}
                >
                  view source conversation →
                </Link>
              </div>
            )}
          </div>
          );
        };
        // Tests split from one conversation group under a collapsible card —
        // a rescued transcript can yield a batch that would otherwise flood
        // the list (and can only be deleted one at a time).
        const byConv = new Map<string, AgentTest[]>();
        const solo: AgentTest[] = [];
        for (const t of tests) {
          if (t.source_conversation_id) {
            const g = byConv.get(t.source_conversation_id) ?? [];
            g.push(t);
            byConv.set(t.source_conversation_id, g);
          } else solo.push(t);
        }
        return (
          <>
            {[...byConv.entries()].map(([convId, ts]) =>
              ts.length === 1 ? (
                <Fragment key={convId}>{renderTest(ts[0])}</Fragment>
              ) : (
                <details
                  key={convId}
                  className="card"
                  style={{ background: 'var(--panel-2)', padding: 12 }}
                >
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                    {ts[0].name.replace(/\s+#\d+$/, '')} — {ts.length} tests
                    <span className="muted" style={{ fontWeight: 400 }}>
                      {' '}· {ts.filter((x) => x.last_run?.passed === true).length} passing
                      {ts.some((x) => x.last_run?.passed === false) &&
                        ` · ${ts.filter((x) => x.last_run?.passed === false).length} failing`}
                    </span>
                  </summary>
                  <div className="row" style={{ margin: '8px 0' }}>
                    <span className="grow muted" style={{ fontSize: 12 }}>
                      split from one conversation — one rescue point each
                    </span>
                    {isAdmin && (
                      <button
                        className="btn sm"
                        disabled={delGroup.isPending}
                        onClick={() => delGroup.mutate(convId)}
                      >
                        {delGroup.isPending ? 'Deleting…' : 'Delete all'}
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {ts.map(renderTest)}
                  </div>
                </details>
              ),
            )}
            {solo.map(renderTest)}
          </>
        );
      })()}

      {batches.length > 0 && (
        <div>
          <div className="muted" style={{ fontSize: 12, fontWeight: 600, margin: '4px 0 6px' }}>
            Run history
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {batches.map((b) => (
              <details key={b.batch_id} style={{ fontSize: 12 }}>
                <summary style={{ cursor: 'pointer' }}>
                  <span className="muted">{timeAgo(b.at)} ago</span>
                  {' '}
                  <span
                    className={`badge ${b.failed ? 'warn' : 'active'}`}
                    style={{ marginLeft: 4 }}
                  >
                    {b.failed
                      ? `${b.passed}/${b.passed + b.failed} passing`
                      : `${b.passed} passing`}
                  </span>
                  <span className="muted" style={{ marginLeft: 6 }}>
                    {b.kind === 'scheduled' ? 'scheduled' : b.kind === 'ab' ? 'A/B' : 'manual'}
                    {b.unrunnable > 0 && ` · ${b.unrunnable} unrunnable`}
                  </span>
                </summary>
                <div style={{ margin: '6px 0 6px 16px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {b.results.map((r) => (
                    <div key={r.test_id}>
                      <span
                        className={`badge ${r.passed === true ? 'active' : r.passed === false ? 'warn' : ''}`}
                      >
                        {r.passed === true ? '✓' : r.passed === false ? '✗' : '—'}
                      </span>
                      {' '}
                      {r.name}
                      {r.reason && <span className="muted"> — {r.reason}</span>}
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
      </ReadOnly>
    </div>
  );
}

/** Form → config.tools entry. Lines-based params/headers keep it simple:
 *  "name — description" and "Header-Name: value". */
function CustomToolForm({
  onAdd,
}: {
  onAdd: (tool: NonNullable<AgentConfig['tools']>[number]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [method, setMethod] = useState<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>('GET');
  const [url, setUrl] = useState('');
  const [paramsText, setParamsText] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [approval, setApproval] = useState(false);
  const [widgetType, setWidgetType] = useState<'' | 'cards' | 'options'>('');
  const [widgetMapText, setWidgetMapText] = useState('');
  const [widgetItems, setWidgetItems] = useState('');
  const [widgetSelectLabel, setWidgetSelectLabel] = useState('');
  const [err, setErr] = useState('');

  const parseLines = (text: string) =>
    Object.fromEntries(
      text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const i = l.indexOf(':') >= 0 ? l.indexOf(':') : l.indexOf('—');
          return i >= 0
            ? [l.slice(0, i).trim(), l.slice(i + 1).trim()]
            : [l, ''];
        }),
    );

  const submit = () => {
    const n = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    if (!n) return setErr('name the action (e.g. lookup_order)');
    if (!/^https?:\/\/|^\{\{/.test(url.trim()))
      return setErr('URL must start with https:// (http only works for localhost in dev)');
    const tool: NonNullable<AgentConfig['tools']>[number] = {
      name: n,
      description: desc.trim() || `Call ${n}`,
      method,
      url: url.trim(),
      ...(headersText.trim() ? { headers: parseLines(headersText) } : {}),
      ...(paramsText.trim() ? { params: parseLines(paramsText) } : {}),
      ...(method !== 'GET' && method !== 'DELETE' ? {} : {}),
      ...(approval ? { approval: true } : {}),
      ...(widgetType
        ? {
            widget: {
              type: widgetType,
              ...(widgetItems.trim() ? { items: widgetItems.trim() } : {}),
              ...(widgetSelectLabel.trim() ? { select_label: widgetSelectLabel.trim() } : {}),
              ...(widgetMapText.trim() ? { map: parseLines(widgetMapText) } : {}),
            },
          }
        : {}),
    };
    onAdd(tool);
    setName('');
    setDesc('');
    setUrl('');
    setParamsText('');
    setHeadersText('');
    setApproval(false);
    setWidgetType('');
    setWidgetMapText('');
    setWidgetItems('');
    setWidgetSelectLabel('');
    setErr('');
    setOpen(false);
  };

  if (!open) {
    return (
      <button className="btn sm" onClick={() => setOpen(true)}>
        + Add custom action
      </button>
    );
  }
  return (
    <div className="card" style={{ background: 'var(--panel-2)', padding: 12 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <input
          className="grow"
          placeholder="name — e.g. lookup_order"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </div>
      <input
        placeholder="endpoint — https://api.example.com/orders/{order_id}"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="mono"
        style={{ width: '100%', fontSize: 12, marginBottom: 8 }}
      />
      <input
        placeholder="what it does — e.g. Look up an order and return status + tracking"
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        style={{ width: '100%', marginBottom: 8 }}
      />
      <textarea
        rows={2}
        placeholder={'arguments, one per line — name: what it is\norder_id: the order number the customer gave'}
        value={paramsText}
        onChange={(e) => setParamsText(e.target.value)}
        style={{ width: '100%', marginBottom: 8 }}
      />
      <textarea
        rows={2}
        placeholder={'headers (optional), one per line\nauthorization: Bearer {{secrets.POS_API_KEY}}'}
        value={headersText}
        onChange={(e) => setHeadersText(e.target.value)}
        className="mono"
        style={{ width: '100%', fontSize: 12, marginBottom: 8 }}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={approval}
          onChange={(e) => setApproval(e.target.checked)}
        />
        Needs approval — the agent proposes this action; a teammate must approve before it runs
      </label>
      <div className="row" style={{ marginTop: 8, alignItems: 'center', gap: 8 }}>
        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          Show the result as
        </span>
        <select
          value={widgetType}
          onChange={(e) => setWidgetType(e.target.value as typeof widgetType)}
        >
          <option value="">just text</option>
          <option value="cards">cards (product/plan carousel)</option>
          <option value="options">options (tap-to-pick list)</option>
        </select>
      </div>
      {widgetType && (
        <>
          <textarea
            rows={3}
            placeholder={
              widgetType === 'cards'
                ? 'field mapping, one per line — title: name\nsubtitle: category\nprice: price\nimage: image_url\nlink: url'
                : 'field mapping, one per line — label: name\ndescription: summary'
            }
            value={widgetMapText}
            onChange={(e) => setWidgetMapText(e.target.value)}
            className="mono"
            style={{ width: '100%', fontSize: 12, marginTop: 8 }}
          />
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <input
              className="grow mono"
              placeholder="rows path (optional) — e.g. data.products"
              value={widgetItems}
              onChange={(e) => setWidgetItems(e.target.value)}
              style={{ fontSize: 12 }}
            />
            {widgetType === 'cards' && (
              <input
                className="grow"
                placeholder="tap label (optional) — e.g. Choose this"
                value={widgetSelectLabel}
                onChange={(e) => setWidgetSelectLabel(e.target.value)}
                style={{ fontSize: 12 }}
              />
            )}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            JSON responses render as the component automatically — the agent narrates them,
            the customer sees real data. Defaults map {widgetType === 'cards' ? 'title/subtitle/price/image/link' : 'label/description'}{' '}
            off each row; override only what differs.
          </div>
        </>
      )}
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary sm" onClick={submit}>
          Add action
        </button>
        <button className="btn sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          Remember to hit Save above — actions are stored with the agent.
        </span>
      </div>
    </div>
  );
}
