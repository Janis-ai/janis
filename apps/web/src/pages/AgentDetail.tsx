import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent, AgentConfig, AgentSecretMeta, AlertRule, Channel } from '@janis/shared';
import { api } from '../api/client';
import { useAgents, useAlertRules, useChannels, useDeliveries } from '../api/hooks';
import { timeAgo } from '../components/bits';

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
  const { data: rulesData } = useAlertRules();
  const { data: channelsData } = useChannels();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [tab, setTab] = useState<Tab>('connection');
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
    { key: 'connection', label: 'Connection' },
    { key: 'integrations', label: 'Integrations' },
    { key: 'behavior', label: 'Behavior' },
    { key: 'escalation', label: 'Escalation' },
    ...(agent.hosted ? [{ key: 'tools' as Tab, label: 'Tools & model' }] : []),
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
          <span className={`badge ${agent.hosted ? 'active' : ''}`}>
            {agent.hosted ? 'hosted' : 'external'}
          </span>
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
              className={`tab${tab === t.key ? ' active' : ''}`}
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

      {tab === 'integrations' && <IntegrationsTab channels={channels} agentId={agent.id} />}
      {tab === 'behavior' && <BehaviorTab agent={agent} cfg={cfg} setCfg={setCfg} />}
      {tab === 'escalation' && (
        <EscalationTab
          cfg={cfg}
          setCfg={setCfg}
          autoResume={autoResume}
          setAutoResume={setAutoResume}
          rules={rules}
          onAddRule={(kind, config) => addRule.mutate({ kind, config })}
          onDeleteRule={(rid) => deleteRule.mutate(rid)}
        />
      )}
      {tab === 'tools' && agent.hosted && <ToolsTab cfg={cfg} setCfg={setCfg} agentId={agent.id} />}
      {tab === 'connection' && (
        <ConnectionTab
          agent={agent}
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

function IntegrationsTab({ channels, agentId }: { channels: Channel[]; agentId: string }) {
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
          <Link to={`/integrations#ch-${ch.id}`} className="btn">Edit</Link>
        </div>
      ))}
      <div style={{ marginTop: channels.length ? 12 : 8 }}>
        <Link to={`/integrations?agent=${agentId}`} className="btn">
          + Add integration
        </Link>
      </div>
      <div className="muted" style={{ marginTop: 10 }}>
        Channel settings (credentials, embed code, per-channel overrides) live on the Integrations page.
      </div>
    </div>
  );
}

function BehaviorTab({
  agent,
  cfg,
  setCfg,
}: {
  agent: Agent;
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
}) {
  const [knowledgeText, setKnowledgeText] = useState(() =>
    (agent.config?.knowledge ?? []).join('\n'),
  );
  const [repliesText, setRepliesText] = useState(() =>
    (agent.config?.quick_replies ?? []).join(', '),
  );

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
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
      <KnowledgeGaps agentId={agent.id} />
    </div>
  );
}

function EscalationTab({
  cfg,
  setCfg,
  autoResume,
  setAutoResume,
  rules,
  onAddRule,
  onDeleteRule,
}: {
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  autoResume: string;
  setAutoResume: (s: string) => void;
  rules: AlertRule[];
  onAddRule: (kind: string, config: Record<string, unknown>) => void;
  onDeleteRule: (id: string) => void;
}) {
  const [kind, setKind] = useState<(typeof RULE_KINDS)[number]>('keyword');
  const [keywords, setKeywords] = useState('');
  const [minutes, setMinutes] = useState('15');

  return (
    <>
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
    </>
  );
}

function ToolsTab({
  cfg,
  setCfg,
  agentId,
}: {
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  agentId: string;
}) {
  const [toolsJson, setToolsJson] = useState(() =>
    cfg.tools ? JSON.stringify(cfg.tools, null, 2) : '',
  );
  const [toolsError, setToolsError] = useState('');

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
      <label>Tools — client APIs the agent can call (JSON array, GET/POST, {'{param}'} URL placeholders)</label>
      <textarea
        rows={4}
        className="mono"
        placeholder={'[\n  {\n    "name": "lookup_order",\n    "description": "Look up an order in our POS by order number",\n    "method": "GET",\n    "url": "https://api.acme-pos.com/orders/{order_id}",\n    "headers": { "authorization": "Bearer {{secrets.POS_API_KEY}}" },\n    "params": { "order_id": "the order number the user gave" }\n  }\n]'}
        value={toolsJson}
        onChange={(e) => setToolsJson(e.target.value)}
        onBlur={() => {
          try {
            const parsed = toolsJson.trim() ? JSON.parse(toolsJson) : undefined;
            setCfg({ ...cfg, tools: parsed });
            setToolsError('');
          } catch {
            setToolsError('invalid JSON — not saved until it parses');
          }
        }}
      />
      {toolsError && <div className="error">{toolsError}</div>}
      <label>
        Secrets — API credentials for tool calls; reference as{' '}
        <span className="mono">{'{{secrets.NAME}}'}</span> in tool URLs and headers
      </label>
      <Secrets agentId={agentId} />
      <label>LLM (OpenAI-compatible — leave blank to use server env)</label>
      <input
        placeholder="API key (sk-…)"
        value={cfg.llm?.api_key ?? ''}
        onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, api_key: e.target.value } })}
      />
      <div className="row">
        <input
          className="grow"
          placeholder="Base URL (default https://api.openai.com/v1)"
          value={cfg.llm?.base_url ?? ''}
          onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, base_url: e.target.value } })}
        />
        <input
          placeholder="Model"
          style={{ width: 160 }}
          value={cfg.llm?.model ?? ''}
          onChange={(e) => setCfg({ ...cfg, llm: { ...cfg.llm, model: e.target.value } })}
        />
      </div>
    </div>
  );
}

function ConnectionTab({
  agent,
  webhookUrl,
  setWebhookUrl,
  onSaveHosted,
  onTestWebhook,
  onRotateKey,
  onRotateSecret,
  onRevealSecret,
}: {
  agent: Agent;
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
            <label>Webhook URL (receives takeover + human messages, HMAC-signed)</label>
            <div className="row">
              <input
                className="grow"
                placeholder="https://your-agent.example.com/janis/webhook"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
              />
              <button className="btn" onClick={onTestWebhook} disabled={!agent.webhook_url}>
                Test
              </button>
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              Run your agent with the template:{' '}
              <span className="mono">
                docker run -e JANIS_API_KEY=… -p 9798:9798 ghcr.io/mnatha/janis-agent
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

      {!agent.hosted && (
      <div className="card" style={{ marginTop: 12 }}>
        <strong>Credentials &amp; deliveries</strong>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={onRotateKey}>
            {agent.api_key_preview ? 'Rotate API key' : 'Generate API key'}
          </button>
          <button className="btn" onClick={onRotateSecret}>Rotate webhook secret</button>
          <button className="btn" onClick={onRevealSecret}>Show webhook secret</button>
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
}

/** Recurring handoff clusters → draft → approve into the knowledge base. */
function KnowledgeGaps({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['knowledge-gaps', agentId],
    queryFn: () => api<{ gaps: Gap[] }>(`/api/agents/${agentId}/knowledge-gaps`),
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

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
    mutationFn: (g: Gap) =>
      api(`/api/agents/${agentId}/knowledge-gaps`, {
        method: 'POST',
        body: JSON.stringify({ entry: drafts[g.key] }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['knowledge-gaps', agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (e) => setError(e.message),
  });

  const gaps = data?.gaps ?? [];
  if (data && !gaps.length) return null;
  return (
    <div className="form-section">
      <strong>Knowledge gaps</strong>
      {gaps.length > 0 && (
        <span className="muted"> — {gaps.length} recurring question{gaps.length > 1 ? 's' : ''} the agent couldn't answer</span>
      )}
      <div style={{ marginTop: 10 }}>
        <div className="muted" style={{ marginBottom: 10 }}>
          These questions triggered handoffs more than once in the last 30 days. Draft an
          answer, edit it, and add it to the knowledge base — nothing changes the agent
          until you approve it.
        </div>
        {error && <div className="error" style={{ marginBottom: 8 }}>{error}</div>}
        {gaps.map((g) => (
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
                    onClick={() => approve.mutate(g)}
                  >
                    Add to knowledge base
                  </button>
                )}
              </div>
            )}
            {drafts[g.key] && !g.added && (
              <textarea
                rows={4}
                style={{ marginTop: 8 }}
                value={drafts[g.key]}
                onChange={(e) => setDrafts((s) => ({ ...s, [g.key]: e.target.value }))}
              />
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
