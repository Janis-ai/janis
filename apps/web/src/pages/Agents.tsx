import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Agent, AgentConfig, AlertRule } from '@janis/shared';
import { api } from '../api/client';
import { useAgents, useAlertRules } from '../api/hooks';

const RULE_KINDS = ['failure', 'handoff_request', 'keyword', 'inactivity', 'custom_alert'] as const;

export default function Agents() {
  const { data } = useAgents();
  const { data: rulesData } = useAlertRules();
  const qc = useQueryClient();
  const [newName, setNewName] = useState('');
  const [freshSecret, setFreshSecret] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState('');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
    void qc.invalidateQueries({ queryKey: ['rules'] });
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
    mutationFn: ({ id, ...body }: { id: string; name?: string; webhook_url?: string | null; config?: AgentConfig }) =>
      api(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
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
          onSave={(body) => update.mutate({ id: agent.id, ...body })}
          onTestWebhook={() => testWebhook.mutate(agent.id)}
          onRotateKey={() => rotateKey.mutate(agent.id)}
          onRotateSecret={() => rotateSecret.mutate(agent.id)}
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
  onSave,
  onTestWebhook,
  onRotateKey,
  onRotateSecret,
  onDelete,
  onAddRule,
  onDeleteRule,
}: {
  agent: Agent;
  rules: AlertRule[];
  onSave: (body: {
    name?: string;
    webhook_url?: string | null;
    auto_resume_minutes?: number | null;
    config?: AgentConfig;
  }) => void;
  onTestWebhook: () => void;
  onRotateKey: () => void;
  onRotateSecret: () => void;
  onDelete: () => void;
  onAddRule: (kind: string, config: Record<string, unknown>) => void;
  onDeleteRule: (id: string) => void;
}) {
  const [webhookUrl, setWebhookUrl] = useState(agent.webhook_url ?? '');
  const [autoResume, setAutoResume] = useState(agent.auto_resume_minutes?.toString() ?? '');
  const [kind, setKind] = useState<(typeof RULE_KINDS)[number]>('keyword');
  const [keywords, setKeywords] = useState('');
  const [minutes, setMinutes] = useState('15');
  const [cfg, setCfg] = useState<AgentConfig>(agent.config ?? {});

  return (
    <div className="card">
      <div className="row">
        <strong className="grow">{agent.name}</strong>
        <span className="mono muted">{agent.api_key_preview}</span>
      </div>

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
          <div>
            <button className="btn" onClick={() => onSave({ config: cfg })}>Save behavior</button>
          </div>
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
        <span className="grow" />
        <button className="btn danger" onClick={onDelete}>Delete agent</button>
      </div>
    </div>
  );
}
