import { useEffect, useRef, useState } from 'react';
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
import { timeAgo } from '../components/bits';
import { SlackChannelSelect } from '../components/SlackChannelSelect';
import { LlmEditor, type LlmBlock } from '../components/LlmEditor';
import { railBus } from '../lib/railBus';

const RULE_KINDS = ['failure', 'handoff_request', 'keyword', 'inactivity', 'custom_alert'] as const;
const TEMPLATE_WEBHOOK = 'http://localhost:9798/webhook';
type Tab = 'integrations' | 'behavior' | 'escalation' | 'tools' | 'connection';

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const { data } = useAgents();
  const agent = data?.agents.find((a) => a.id === id);

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
  const isAdmin = me?.user.role === 'admin';
  const { data: rulesData } = useAlertRules();
  const { data: channelsData } = useChannels();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  // Tab lives in the URL (?tab=…) so refresh/back/deep links keep position.
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab') as Tab | null;
  const tab: Tab =
    tabParam && ['integrations', 'behavior', 'escalation', 'tools', 'connection'].includes(tabParam)
      ? tabParam
      : 'connection';
  const activeTab: Tab = tab === 'tools' && !agent.hosted ? 'connection' : tab;
  const setTab = (t: Tab) => setParams(t === 'connection' ? {} : { tab: t });
  const [freshSecret, setFreshSecret] = useState<{ label: string; value: string } | null>(
    () => (location.state as { freshSecret?: { label: string; value: string } })?.freshSecret ?? null,
  );
  const [error, setError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  // draft state — one shared cfg, saved wholesale by the header Save button
  const [name, setName] = useState(agent.name);
  const [cfg, setCfg] = useState<AgentConfig>(agent.config ?? {});
  const [autoResume, setAutoResume] = useState(agent.auto_resume_minutes?.toString() ?? '');
  const [webhookUrl, setWebhookUrl] = useState(agent.webhook_url ?? '');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
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
    { key: 'integrations', label: 'Channels' },
    { key: 'behavior', label: 'Behavior' },
    { key: 'escalation', label: 'Escalation' },
    ...(agent.hosted ? [{ key: 'tools' as Tab, label: 'Integrations' }] : []),
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

      {freshSecret && (
        <div className="card" style={{ borderColor: 'var(--accent)', marginTop: 12 }}>
          <div className="muted">{freshSecret.label} — copy it now, it won't be shown again:</div>
          <div className="mono" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>{freshSecret.value}</div>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {activeTab === 'integrations' && <IntegrationsTab channels={channels} agent={agent} />}
      {activeTab === 'behavior' && <BehaviorTab agent={agent} cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />}
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
      {activeTab === 'tools' && agent.hosted && <ToolsTab cfg={cfg} setCfg={setCfg} agentId={agent.id} isAdmin={isAdmin} />}
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
        />
      )}

      {isAdmin && (
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Delete agent "${agent.name}"?`)) removeAgent.mutate();
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

const KIND_LABEL: Record<string, string> = {
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  webchat: 'Web chat',
};

function IntegrationsTab({
  channels,
  agent,
}: {
  channels: Channel[];
  agent: Agent;
}) {
  const agentId = agent.id;
  const agentName = agent.name;
  const { data: me } = useMe();
  const isAdmin = me?.user.role === 'admin';
  const overrides = (ch: Channel) => {
    const bits: string[] = [];
    if (ch.meta.branding?.greeting) bits.push('custom greeting');
    const replies = ch.meta.branding?.quick_replies?.length ?? 0;
    if (replies) bits.push(`${replies} suggested repl${replies === 1 ? 'y' : 'ies'}`);
    return bits.join(' · ');
  };

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
      {channels.length === 0 && (
        <div className="muted">
          Nothing is connected — this agent isn't answering anywhere yet.
        </div>
      )}
      {channels.map((ch) => (
        <div key={ch.id} className="row" style={{ alignItems: 'baseline' }}>
          <span className="badge active">{KIND_LABEL[ch.kind] ?? ch.kind}</span>
          <strong className="grow">{ch.name}</strong>
          <span className="muted">
            {ch.meta.page_id && `page ${ch.meta.page_id}`}
            {ch.meta.phone_number_id && ch.meta.phone_number_id}
            {overrides(ch) && ` · ${overrides(ch)}`}
          </span>
          {ch.meta.chat_url && (
            <a href={ch.meta.chat_url} target="_blank" rel="noreferrer" className="btn">
              Open ↗
            </a>
          )}
          {isAdmin && (
            <Link
              to={`/integrations/${ch.id}`}
              state={{ from: `/agents/${agentId}?tab=integrations`, label: agentName }}
              className="btn"
            >
              Edit
            </Link>
          )}
        </div>
      ))}
      {isAdmin && (
        <div style={{ marginTop: channels.length ? 12 : 8 }}>
          <Link to={`/integrations?agent=${agentId}`} className="btn">
            + Add channel
          </Link>
        </div>
      )}
      <div className="muted" style={{ marginTop: 10 }}>
        Channel settings (credentials, embed code, per-channel overrides) live on the Channels page.
      </div>
    </div>
  );
}

/** Per-agent Slack alert channel — overrides the workspace default so each
 * agent can escalate into its own channel (e.g. #janis-support). */
function SlackAlerts({ agent }: { agent: Agent }) {
  const { data: me } = useMe();
  const isAdmin = me?.user.role === 'admin';
  const { data: slack } = useSlackStatus();
  const installations = slack?.installations ?? [];
  const effInstId = agent.slack_installation_id ?? installations[0]?.id ?? null;
  const { data: slackChannels } = useSlackChannels(!!slack?.connected, effInstId);
  const { data: defaultChannels } = useSlackChannels(
    !!slack?.connected && effInstId !== installations[0]?.id,
    installations[0]?.id,
  );
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
    void qc.invalidateQueries({ queryKey: ['slackChannels'] });
  };
  const setRoute = useMutation({
    mutationFn: (patch: { slack_installation_id?: string | null; slack_channel_id?: string | null }) =>
      api(`/api/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: refresh,
    onError: (e) => setMsg(e.message),
  });
  const createChannel = useMutation({
    mutationFn: (name: string) =>
      api<{ channel: { id: string; name: string } }>('/api/slack/channel', {
        method: 'POST',
        body: JSON.stringify({ name, agent_id: agent.id }),
      }),
    onSuccess: (res) => {
      // Merge into the channel list now — conversations.list can lag on new
      // channels, so a plain refetch would briefly drop the option.
      qc.setQueryData<{ channels: { id: string; name: string }[] }>(
        ['slackChannels', effInstId ?? ''],
        (old) => ({
          channels: old?.channels.some((ch) => ch.id === res.channel.id)
            ? old.channels
            : [...(old?.channels ?? []), res.channel],
        }),
      );
      refresh();
      setMsg(`Created #${res.channel.name} — this agent's alerts now post there.`);
    },
    onError: (e) => setMsg(e.message),
  });
  if (!slack?.connected) return null;
  const effInst = installations.find((i) => i.id === effInstId);
  const instChannel = slackChannels?.channels.find((ch) => ch.id === effInst?.alert_channel_id);
  const defaultInstChannel = defaultChannels?.channels.find(
    (ch) => ch.id === installations[0]?.alert_channel_id,
  );
  const instLabel = (i?: { team_name: string | null; team_id: string }) =>
    i?.team_name ?? i?.team_id ?? 'Slack';
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <strong>Slack alerts</strong>
      <div className="muted" style={{ margin: '4px 0 8px' }}>
        Where this agent's escalations post. Inherits the workspace defaults unless you
        override the Slack workspace or channel.
      </div>
      {isAdmin ? (
        <>
          {installations.length > 0 && (
            <div className="row" style={{ marginBottom: 8 }}>
              <label className="muted" style={{ minWidth: 110 }}>Slack workspace</label>
              <select
                value={agent.slack_installation_id ?? ''}
                disabled={setRoute.isPending}
                onChange={(e) =>
                  // switching workspaces invalidates the channel — clear it
                  setRoute.mutate({
                    slack_installation_id: e.target.value || null,
                    slack_channel_id: null,
                  })
                }
              >
                <option value="">
                  Default ({instLabel(installations[0])})
                </option>
                {installations.map((i) => (
                  <option key={i.id} value={i.id}>
                    {instLabel(i)}
                  </option>
                ))}
              </select>
              {slack.configured && (
                <a className="btn" href="/api/slack/install">Add workspace</a>
              )}
            </div>
          )}
          <div className="row">
            <label className="muted" style={{ minWidth: 110 }}>Channel</label>
            <SlackChannelSelect
              channels={slackChannels?.channels}
              value={agent.slack_channel_id ?? ''}
              inheritLabel={
                instChannel
                  ? `Workspace channel (#${instChannel.name})`
                  : 'Workspace channel (default)'
              }
              defaultName={`janis-${agent.name}`}
              busy={setRoute.isPending || createChannel.isPending}
              onPick={(id) => setRoute.mutate({ slack_channel_id: id })}
              onCreate={async (name) => {
                await createChannel.mutateAsync(name);
              }}
            />
          </div>
        </>
      ) : (
        <div className="muted">
          {agent.slack_installation_id && effInst
            ? `${instLabel(effInst)} — `
            : ''}
          {agent.slack_channel_id
            ? `#${slackChannels?.channels.find((ch) => ch.id === agent.slack_channel_id)?.name ?? agent.slack_channel_id}`
            : `Workspace channel${(instChannel ?? defaultInstChannel) ? ` (#${(instChannel ?? defaultInstChannel)!.name})` : ''}`}
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

function BehaviorTab({
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
  const [knowledgeText, setKnowledgeText] = useState(() =>
    (agent.config?.knowledge ?? []).join('\n'),
  );
  const [repliesText, setRepliesText] = useState(() =>
    (agent.config?.quick_replies ?? []).join(', '),
  );

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
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
      <label>Knowledge files — PDFs, docs, text, images; the agent answers from these</label>
      <KnowledgeFiles agentId={agent.id} />
      <KnowledgeGaps agentId={agent.id} config={agent.config ?? {}} />
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
  const [minutes, setMinutes] = useState('15');

  return (
    <>
    {/* Per-agent overrides — same order as the Settings page. Profile and
        Notifications are self-service (each operator sets their own), so
        they sit outside the admin read-only wrapper. */}
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

      <SlackAlerts agent={agent} />

      <AgentSavedRepliesCard agent={agent} />

      <AgentTeamCard agent={agent} isAdmin={isAdmin} />

      <div className="card" style={{ marginTop: 12 }}>
        <strong>Alert rules</strong>
        {rules.map((r) => (
          <div key={r.id} className="row muted" style={{ marginTop: 6 }}>
            <span className="grow">
              {r.kind}
              {r.config.keywords?.length ? `: ${r.config.keywords.join(', ')}` : ''}
              {r.config.inactivity_minutes ? ` (${r.config.inactivity_minutes}m)` : ''}
            </span>
            <button className="btn danger" onClick={() => onDeleteRule(r.id)}>✕</button>
          </div>
        ))}
        <div className="row" style={{ marginTop: 8 }}>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {RULE_KINDS.map((k) => <option key={k}>{k}</option>)}
          </select>
          {kind === 'keyword' && (
            <input
              className="grow"
              placeholder="keywords, comma separated"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
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
          <button
            className="btn"
            onClick={() =>
              onAddRule(kind, {
                enabled: true,
                ...(kind === 'keyword'
                  ? { keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean) }
                  : {}),
                ...(kind === 'inactivity' ? { inactivity_minutes: Number(minutes) } : {}),
              })
            }
          >
            Add rule
          </button>
        </div>
      </div>
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
          <button className="btn danger" onClick={() => remove.mutate(r.id)}>✕</button>
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

  const roleSelect = (userId: string, value: string, inherited: string | null) =>
    isAdmin ? (
      <select
        value={value}
        onChange={(e) =>
          setRole.mutate({ userId, role: e.target.value === 'inherit' ? null : e.target.value })
        }
      >
        {inherited !== null && <option value="inherit">inherit ({inherited})</option>}
        <option value="member">member</option>
        <option value="admin">admin</option>
      </select>
    ) : (
      <span className="badge active">{value === 'inherit' ? inherited : value}</span>
    );

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <strong>Team</strong>
      <div className="muted" style={{ margin: '4px 0 8px' }}>
        Workspace members can see every agent — a role set here overrides
        theirs for this agent only. People added with no workspace account
        become agent-only users who see nothing but this agent.
      </div>
      {plainMembers.map((u) => (
        <div key={u.id} className="row muted" style={{ marginTop: 6 }}>
          <span className="grow">
            {u.name} · {u.email}
          </span>
          {roleSelect(u.id, 'inherit', u.role)}
          {isAdmin && u.id !== me?.user.id && (
            <button className="btn danger" onClick={() => remove.mutate(u.id)} title="Clear override">
              ✕
            </button>
          )}
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
            {roleSelect(m.user_id, m.role ?? 'inherit', wsById.get(m.user_id)?.role ?? 'member')}
            {isAdmin && (
              <button className="btn danger" onClick={() => remove.mutate(m.user_id)} title="Clear override">
                ✕
              </button>
            )}
          </div>
        ))}
      {agentOnly.map((m) => (
        <div key={m.user_id} className="row muted" style={{ marginTop: 6 }}>
          <span className="grow">
            {m.name} · {m.email}
            <span className="badge" style={{ marginLeft: 8 }}>this agent only</span>
          </span>
          {roleSelect(m.user_id, m.role ?? 'member', null)}
          {isAdmin && (
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
  const [toolsJson, setToolsJson] = useState(() =>
    cfg.tools ? JSON.stringify(cfg.tools, null, 2) : '',
  );
  const [toolsError, setToolsError] = useState('');
  const [toolsDirty, setToolsDirty] = useState(false);
  const [toolsStale, setToolsStale] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const lastTools = useRef(cfg.tools);

  // Re-sync the editor when cfg.tools changes externally (template
  // install/remove) — otherwise the stale textarea overwrites them on blur.
  useEffect(() => {
    if (cfg.tools === lastTools.current) return;
    lastTools.current = cfg.tools;
    if (toolsDirty) setToolsStale(true);
    else setToolsJson(cfg.tools ? JSON.stringify(cfg.tools, null, 2) : '');
  }, [cfg.tools, toolsDirty]);

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
      <label>Custom API actions — call any API (JSON array, GET/POST/PUT/PATCH/DELETE, {'{param}'} URL placeholders, "approval": true gates a call behind teammate sign-off)</label>
      <textarea
        rows={4}
        className="mono"
        placeholder={'[\n  {\n    "name": "lookup_order",\n    "description": "Look up an order in our POS by order number",\n    "method": "GET",\n    "url": "https://api.acme-pos.com/orders/{order_id}",\n    "headers": { "authorization": "Bearer {{secrets.POS_API_KEY}}" },\n    "params": { "order_id": "the order number the user gave" }\n  }\n]'}
        value={toolsJson}
        onChange={(e) => {
          setToolsJson(e.target.value);
          setToolsDirty(true);
        }}
        onBlur={() => {
          try {
            const parsed = toolsJson.trim() ? JSON.parse(toolsJson) : undefined;
            setCfg({ ...cfg, tools: parsed });
            setToolsDirty(false);
            setToolsStale(false);
            setToolsError('');
          } catch {
            setToolsError('invalid JSON — not saved until it parses');
          }
        }}
      />
      {toolsError && <div className="error">{toolsError}</div>}
      {toolsStale && (
        <div className="muted">
          Tools changed via the integrations above — your JSON edits will overwrite them.{' '}
          <button
            className="btn"
            onClick={() => {
              setToolsJson(cfg.tools ? JSON.stringify(cfg.tools, null, 2) : '');
              setToolsDirty(false);
              setToolsStale(false);
              setToolsError('');
            }}
          >
            Discard my edits
          </button>
        </div>
      )}
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
          <div className="muted" style={{ fontSize: 11, margin: '0 0 10px', lineHeight: 1.7 }}>
            {t.tools.map((x) => (
              <div key={x.name}>
                <span className="mono">{x.name}</span>
                {x.approval && (
                  <span className="badge" style={{ marginLeft: 6 }}>needs approval</span>
                )}
              </div>
            ))}
          </div>
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
            <div className="row">
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
}) {
  const navigate = useNavigate();
  const [testMsg, setTestMsg] = useState('');
  const [showDeliveries, setShowDeliveries] = useState(false);
  const { data: deliveries } = useDeliveries(showDeliveries ? agent.id : null);
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
            Janis runs this agent in-process with the config in the other tabs — replies go
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
              Run your agent with the template:{' '}
              <span className="mono">
                docker run -e JANIS_API_KEY=… -p 9798:9798 ghcr.io/janis-ai/janis-agent
              </span>
              {' '}— full contract + quickstart in the{' '}
              <a href="/docs" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                BYOK docs
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

      {agent.hosted && <LlmCard agent={agent} cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />}

      {!agent.hosted && (
      <div className="card" style={{ marginTop: 12 }}>
        <strong>Credentials &amp; deliveries</strong>
        <div className="row" style={{ marginTop: 8 }}>
          {isAdmin && (
            <>
              <button className="btn" onClick={onRotateKey}>
                {agent.api_key_preview ? 'Rotate API key' : 'Generate API key'}
              </button>
              <button className="btn" onClick={onRotateSecret}>Rotate webhook secret</button>
              <button className="btn" onClick={onRevealSecret}>Show webhook secret</button>
            </>
          )}
          <button className="btn" onClick={() => setShowDeliveries((s) => !s)}>
            {showDeliveries ? 'Hide deliveries' : 'Deliveries'}
          </button>
        </div>
        {showDeliveries && (
          <div className="muted" style={{ marginTop: 10 }}>
            {deliveries?.deliveries.length === 0 && <div>No deliveries yet.</div>}
            {deliveries?.deliveries.map((d) => (
              <div key={d.id} className="row" style={{ marginTop: 4 }}>
                <span className={`badge ${d.status === 'delivered' ? 'active' : 'needs_human'}`}>
                  {d.status}
                </span>
                <span className="mono">{d.type}</span>
                <span className="grow">{d.last_error ?? ''}</span>
                <span>{timeAgo(d.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      )}
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
            📄 {f.name}
            <span className="muted">
              {' '}— {Math.max(1, Math.round(f.size_bytes / 1024))}KB → {f.chars.toLocaleString()} chars
            </span>
            {f.status === 'failed' && <span className="error"> {f.error}</span>}
          </span>
          <button className="btn danger" onClick={() => remove.mutate(f.id)}>✕</button>
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
    }) =>
      api(`/api/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          config: {
            ...config,
            [v.field]: [...new Set([...(config[v.field] ?? []), ...v.keys])],
          },
        }),
      }),
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
  const gapKey = (q: string) => q.toLowerCase().slice(0, 60);
  // a cluster stays dismissed while every visible phrasing was dismissed —
  // a new phrasing of the same intent resurfaces it
  const gaps = (data?.gaps ?? []).filter(
    (g) =>
      !dismissedG.has(g.key) &&
      !g.questions.every((q) => dismissedG.has(gapKey(q))),
  );
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
          <button className="btn danger" onClick={() => remove.mutate(s.name)}>✕</button>
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
