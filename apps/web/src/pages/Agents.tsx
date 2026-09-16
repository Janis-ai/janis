import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent, AgentConfig, AgentSecretMeta, AlertRule } from '@janis/shared';
import { api } from '../api/client';
import { useAgents, useAlertRules, useChannels, useDeliveries } from '../api/hooks';
import { timeAgo } from '../components/bits';

const RULE_KINDS = ['failure', 'handoff_request', 'keyword', 'inactivity', 'custom_alert'] as const;
const TEMPLATE_WEBHOOK = 'http://localhost:9798/webhook';

export default function Agents() {
  const { data } = useAgents();
  const { data: rulesData } = useAlertRules();
  const { data: channelsData } = useChannels();
  const qc = useQueryClient();
  const [newName, setNewName] = useState('');
  const [freshSecret, setFreshSecret] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState('');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
    void qc.invalidateQueries({ queryKey: ['rules'] });
    void qc.invalidateQueries({ queryKey: ['deliveries'] });
  };

  const create = useMutation({
    mutationFn: (name: string) =>
      api<{ agent: Agent; api_key: string }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    onSuccess: (r) => {
      setNewName('');
      setFreshSecret({ label: 'New API key', value: r.api_key });
      refresh();
    },
    onError: (e) => setError(e.message),
  });

  const update = useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      webhook_url?: string | null;
      hosted?: boolean;
      auto_resume_minutes?: number | null;
      config?: AgentConfig;
    }) => api(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  const testWebhook = useMutation({
    mutationFn: (id: string) => api(`/api/agents/${id}/webhook-test`, { method: 'POST' }),
    onError: (e) => setError(e.message),
  });

  const rotateKey = useMutation({
    mutationFn: (id: string) =>
      api<{ api_key: string }>(`/api/agents/${id}/rotate-key`, { method: 'POST' }),
    onSuccess: (r) => { setFreshSecret({ label: 'New API key', value: r.api_key }); refresh(); },
    onError: (e) => setError(e.message),
  });

  const rotateSecret = useMutation({
    mutationFn: (id: string) =>
      api<{ webhook_secret: string }>(`/api/agents/${id}/rotate-webhook-secret`, { method: 'POST' }),
    onSuccess: (r) => { setFreshSecret({ label: 'New webhook secret', value: r.webhook_secret }); refresh(); },
    onError: (e) => setError(e.message),
  });

  const removeAgent = useMutation({
    mutationFn: (id: string) => api(`/api/agents/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  const addRule = useMutation({
    mutationFn: (body: { agent_id: string; kind: string; config: Record<string, unknown> }) =>
      api('/api/rules', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => api(`/api/rules/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  return (
    <>
      <h1 className="page-title">Agents</h1>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (newName.trim()) create.mutate(newName.trim());
        }}
      >
        <input
          className="grow"
          placeholder="New agent name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button className="btn primary">Create agent</button>
      </form>

      {freshSecret && (
        <div className="card" style={{ borderColor: 'var(--accent)', marginTop: 12 }}>
          <div className="muted">{freshSecret.label} — copy it now, it won't be shown again:</div>
          <div className="mono">{freshSecret.value}</div>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {data?.agents.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          rules={rulesData?.rules.filter((r) => r.agent_id === agent.id) ?? []}
          channels={channelsData?.channels.filter((c) => c.agent_id === agent.id) ?? []}
          onSave={(body, opts) =>
            update.mutate({ id: agent.id, ...body }, { onSuccess: opts?.onSuccess })
          }
          saving={update.isPending && update.variables?.id === agent.id}
          onTestWebhook={() => testWebhook.mutate(agent.id)}
          onRotateKey={() => rotateKey.mutate(agent.id)}
          onRotateSecret={() => rotateSecret.mutate(agent.id)}
          onRevealSecret={async () => {
            const r = await api<{ webhook_secret: string }>(`/api/agents/${agent.id}/webhook-secret`);
            setFreshSecret({ label: 'Webhook secret', value: r.webhook_secret });
          }}
          onDelete={() => { if (confirm(`Delete agent "${agent.name}"?`)) removeAgent.mutate(agent.id); }}
          onAddRule={(kind, config) => addRule.mutate({ agent_id: agent.id, kind, config })}
          onDeleteRule={(id) => deleteRule.mutate(id)}
        />
      ))}
    </>
  );
}

function AgentCard({
  agent,
  rules,
  channels,
  saving,
  onSave,
  onTestWebhook,
  onRotateKey,
  onRotateSecret,
  onRevealSecret,
  onDelete,
  onAddRule,
  onDeleteRule,
}: {
  agent: Agent;
  rules: AlertRule[];
  channels: { id: string; kind: string; name: string }[];
  saving: boolean;
  onSave: (
    body: {
      name?: string;
      webhook_url?: string | null;
      hosted?: boolean;
      auto_resume_minutes?: number | null;
      config?: AgentConfig;
    },
    opts?: { onSuccess?: () => void },
  ) => void;
  onTestWebhook: () => void;
  onRotateKey: () => void;
  onRotateSecret: () => void;
  onRevealSecret: () => void;
  onDelete: () => void;
  onAddRule: (kind: string, config: Record<string, unknown>) => void;
  onDeleteRule: (id: string) => void;
}) {
  const [name, setName] = useState(agent.name);
  const [webhookUrl, setWebhookUrl] = useState(agent.webhook_url ?? '');
  const [autoResume, setAutoResume] = useState(agent.auto_resume_minutes?.toString() ?? '');
  const [kind, setKind] = useState<(typeof RULE_KINDS)[number]>('keyword');
  const [keywords, setKeywords] = useState('');
  const [minutes, setMinutes] = useState('15');
  const [cfg, setCfg] = useState<AgentConfig>(agent.config ?? {});
  const [toolsJson, setToolsJson] = useState(() =>
    agent.config?.tools ? JSON.stringify(agent.config.tools, null, 2) : '',
  );
  const [toolsError, setToolsError] = useState('');
  const [showDeliveries, setShowDeliveries] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const navigate = useNavigate();
  const onTestChat = async (text: string) => {
    const r = await api<{ conversation_id: string | null }>(`/api/agents/${agent.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (r.conversation_id) navigate(`/conversations/${r.conversation_id}`);
  };
  const { data: deliveries } = useDeliveries(showDeliveries ? agent.id : null);

  return (
    <div className="card">
      <div className="row">
        <input
          className="grow"
          style={{ fontWeight: 700 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== agent.name && onSave({ name: name.trim() })}
        />
        <span className="mono muted" title="API key preview">{agent.api_key_preview}</span>
      </div>
      <div className="muted" style={{ margin: '4px 0 10px' }}>
        {agent.last_seen_at ? `last event ${timeAgo(agent.last_seen_at)}` : 'no events yet'}
        {channels.length > 0 && ` · channels: ${channels.map((c) => c.name).join(', ')}`}
      </div>

      <div className="row" style={{ marginBottom: 10 }}>
        <label style={{ margin: 0 }}>Runs</label>
        <select
          value={agent.hosted ? 'hosted' : 'external'}
          onChange={(e) => onSave({ hosted: e.target.value === 'hosted' })}
        >
          <option value="hosted">Hosted by Janis — nothing to deploy</option>
          <option value="external">External webhook — you run the agent</option>
        </select>
      </div>

      {agent.hosted ? (
        <div className="muted" style={{ margin: '4px 0 10px' }}>
          Janis runs this agent in-process with the config below — replies go straight to the
          connected channel. No webhook, no deploy.
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
            <button className="btn" onClick={() => onSave({ webhook_url: webhookUrl || null })}>Save</button>
            <button className="btn" onClick={onTestWebhook} disabled={!agent.webhook_url}>Test</button>
          </div>
          <div className="muted" style={{ margin: '4px 0 10px' }}>
            Using the Janis agent template?{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); setWebhookUrl(TEMPLATE_WEBHOOK); onSave({ webhook_url: TEMPLATE_WEBHOOK }); }}>
              point it at the local template
            </a>
            {' '}then run{' '}
            <span className="mono">JANIS_API_KEY=… npm run start -w packages/agent-template</span>
          </div>
        </>
      )}

      <label>Auto-resume — release a human takeover back to the agent after N minutes (blank = never)</label>
      <div className="row">
        <input
          type="number"
          min={1}
          style={{ width: 110 }}
          placeholder="minutes"
          value={autoResume}
          onChange={(e) => setAutoResume(e.target.value)}
        />
        <button
          className="btn"
          onClick={() => onSave({ auto_resume_minutes: autoResume ? Number(autoResume) : null })}
        >
          Save
        </button>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer' }}>
          <strong>Bot behavior</strong> — used by the Janis agent template (prompt + knowledge)
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
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
            value={(cfg.knowledge ?? []).join('\n')}
            onChange={(e) => setCfg({ ...cfg, knowledge: e.target.value.split('\n').filter(Boolean) })}
          />
          <label>Tone</label>
          <input
            placeholder="e.g. warm, concise, never apologetic"
            value={cfg.tone ?? ''}
            onChange={(e) => setCfg({ ...cfg, tone: e.target.value })}
          />
          <label>Knowledge files — PDFs, docs, text, images; the agent answers from these</label>
          <KnowledgeFiles agentId={agent.id} />
          {agent.hosted && (
            <>
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
              <Secrets agentId={agent.id} />
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
            </>
          )}
        </div>
      </details>

      <label>Alert rules</label>
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

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" onClick={onRotateKey}>Rotate API key</button>
        <button className="btn" onClick={onRotateSecret}>Rotate webhook secret</button>
        <button className="btn" onClick={onRevealSecret}>Show webhook secret</button>
        <button className="btn" onClick={() => setShowDeliveries((s) => !s)}>
          {showDeliveries ? 'Hide deliveries' : 'Deliveries'}
        </button>
        <span className="grow" />
        <button
          className="btn primary"
          disabled={saving}
          onClick={() =>
            onSave(
              {
                ...(name.trim() && name.trim() !== agent.name ? { name: name.trim() } : {}),
                ...(agent.hosted ? {} : { webhook_url: webhookUrl || null }),
                auto_resume_minutes: autoResume ? Number(autoResume) : null,
                config: cfg,
              },
              {
                onSuccess: () => {
                  setSavedFlash(true);
                  setTimeout(() => setSavedFlash(false), 2000);
                },
              },
            )
          }
        >
          {saving ? 'Saving…' : savedFlash ? 'Saved ✓' : 'Save Agent'}
        </button>
        <button className="btn danger" onClick={onDelete}>Delete agent</button>
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
