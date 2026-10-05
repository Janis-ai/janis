import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAgents, useMe } from '../api/hooks';
import { janisBrain, setLastAgent } from '../lib/agentContext';
import { usePageTitle } from '../lib/title';
import type { Agent, AgentConfig } from '@janis/shared';
import { AskJanis } from '../components/AskJanis';
import { AgentChannels } from '../components/AgentChannels';
import {
  GreetingSection,
  InstructionsSection,
  KnowledgeFiles,
  KnowledgeTextSection,
  LlmCard,
  ToolsTab,
} from './AgentDetail';

/** Guided agent builder — Purpose → Knowledge → Behavior → Actions → Test →
 *  Deploy. Not a rigid form: stages are click-through, edits save to the
 *  live agent as you go, and every stage is the same surface the agent's
 *  workspace exposes afterwards. */
interface BuilderDraft {
  generated?: boolean;
  note?: string;
  name?: string;
  system_prompt?: string;
  greeting?: string;
}

const STEPS = [
  { key: 'purpose', label: 'Purpose', hint: 'what it does' },
  { key: 'knowledge', label: 'Knowledge', hint: 'what it knows' },
  { key: 'behavior', label: 'Behavior', hint: 'how it behaves' },
  { key: 'actions', label: 'Actions', hint: 'what it can do' },
  { key: 'test', label: 'Test', hint: 'prove it works' },
  { key: 'deploy', label: 'Deploy', hint: 'put it to work' },
] as const;
type StepKey = (typeof STEPS)[number]['key'];

export default function AgentBuilder() {
  usePageTitle('New agent');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const isAdmin = me?.user.role === 'admin';
  const { data: agentsData } = useAgents();
  const qc = useQueryClient();

  // The agent id is a PATH segment (/agents/new/:agentId) — never ?agent=:
  // the layout's rail URL-sync stamps ?agent=<test-rail agent> onto every
  // navigation while the test rail is open, which silently resolved the
  // builder to an existing agent.
  const { agentId } = useParams<{ agentId?: string }>();
  const agent = agentsData?.agents.find((a) => a.id === agentId) ?? null;
  const hosted = agent ? janisBrain(agent) : true;
  const stepParam = params.get('step');
  const step: StepKey = STEPS.some((s) => s.key === stepParam)
    ? (stepParam as StepKey)
    : agent
      ? 'knowledge'
      : 'purpose';
  const goStep = (s: StepKey) => {
    navigate(`/agents/new${agent ? `/${agent.id}` : ''}?step=${s}`, { replace: true });
  };

  // Purpose stage — name + natural-language description → POST
  // /api/agents/bootstrap creates the agent with a generated draft config.
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [hostedFlag, setHostedFlag] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<BuilderDraft | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api<{ agent: Agent; draft?: BuilderDraft }>('/api/agents/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim() || undefined,
          purpose: purpose.trim() || undefined,
          hosted: hostedFlag,
        }),
      }),
    onSuccess: (r) => {
      setDraft(r.draft ?? null);
      setLastAgent(r.agent.id);
      void qc.invalidateQueries({ queryKey: ['agents'] });
      navigate(`/agents/new/${r.agent.id}?step=purpose`, { replace: true });
    },
    onError: (e) => setError(e.message),
  });

  // Shared config draft — the same {config} PATCH the agent editor uses.
  const [cfg, setCfg] = useState<AgentConfig>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setCfg(agent?.config ?? {});
  }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveCfg = useMutation({
    mutationFn: () =>
      api(`/api/agents/${agent?.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ config: cfg }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: (e) => setError(e.message),
  });

  // Test stage — the agent's test channel drives a real conversation
  // (same AskJanis pane the right rail uses).
  const testChannel = useMutation({
    mutationFn: () =>
      api<{ channel_id: string }>(`/api/agents/${agent?.id}/test-channel`, {
        method: 'POST',
      }),
  });
  useEffect(() => {
    if (step === 'test' && agent && hosted && !testChannel.data && !testChannel.isPending) {
      testChannel.mutate();
    }
  }, [step, agent?.id, hosted]); // eslint-disable-line react-hooks/exhaustive-deps

  const builder = cfg.builder;
  const idx = STEPS.findIndex((s) => s.key === step);
  const next = STEPS[idx + 1];

  return (
    <>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 className="page-title grow">
          {agent ? agent.name : 'New agent'}
        </h1>
        {agent && (
          <Link className="muted" to={`/agents/${agent.id}`}>Open workspace →</Link>
        )}
      </div>

      <div className="builder-steps">
        {STEPS.map((s, i) => {
          const locked = !agent && i > 0;
          const done = agent && i < idx;
          return (
            <button
              key={s.key}
              className={`builder-step${step === s.key ? ' active' : ''}${done ? ' done' : ''}`}
              disabled={locked}
              title={locked ? 'Create the agent first' : s.hint}
              onClick={() => goStep(s.key)}
            >
              <span className="builder-step-n">{done ? '✓' : i + 1}</span>
              <span className="builder-step-label">{s.label}</span>
              <span className="builder-step-hint">{s.hint}</span>
            </button>
          );
        })}
      </div>

      {error && <div className="error">{error}</div>}
      {saved && <div className="muted" style={{ margin: '6px 0' }}>Saved ✓</div>}

      {step === 'purpose' && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>Purpose — what should this agent do?</strong>
          {!agent ? (
            <>
              <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                Describe the agent's job in your own words. Janis drafts a starting
                configuration — instructions, greeting, the integrations and
                approval gates it probably needs — and you refine it in the next
                stages.
              </div>
              <input
                className="input"
                style={{ width: '100%', marginTop: 12, boxSizing: 'border-box' }}
                placeholder="Agent name (optional — we can name it for you)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <textarea
                rows={5}
                style={{ width: '100%', marginTop: 10, boxSizing: 'border-box' }}
                placeholder={
                  'e.g. "A customer support agent for my ecommerce store that answers ' +
                  'order and shipping questions and can issue refunds when appropriate."'
                }
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              />
              <label className="check-label" style={{ marginTop: 10, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={hostedFlag}
                  onChange={(e) => setHostedFlag(e.target.checked)}
                />
                <span>Hosted by Janis</span>
              </label>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {hostedFlag
                  ? 'Janis writes the replies — knowledge, tests, and actions included.'
                  : 'External webhook — your own backend answers inbound events.'}
              </div>
              <div className="row" style={{ marginTop: 14, gap: 8 }}>
                <button
                  className="btn primary"
                  disabled={create.isPending || isAdmin === false}
                  title={purpose.trim() ? '' : 'No description — creates a blank agent you configure yourself'}
                  onClick={() => create.mutate()}
                >
                  {create.isPending
                    ? 'Building agent…'
                    : purpose.trim()
                      ? 'Create agent with AI draft'
                      : 'Create agent'}
                </button>
              </div>
              {create.isPending && purpose.trim() && (
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Drafting the configuration — usually a few seconds.
                </div>
              )}
            </>
          ) : (
            <>
              <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                The agent's job statement — it anchors everything else you
                configure. Edit and Save to update.
              </div>
              <textarea
                rows={4}
                style={{ width: '100%', marginTop: 10, boxSizing: 'border-box' }}
                value={cfg.purpose ?? ''}
                onChange={(e) => setCfg({ ...cfg, purpose: e.target.value })}
              />
              {draft && (
                <div className="card" style={{ margin: '12px 0 0', background: 'var(--bg)' }}>
                  <strong style={{ fontSize: 13 }}>
                    {draft.generated ? 'Generated draft — review and refine' : 'Created'}
                  </strong>
                  {draft.note && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{draft.note}</div>
                  )}
                  {draft.system_prompt && (
                    <div style={{ marginTop: 8 }}>
                      <div className="muted" style={{ fontSize: 12 }}>Instructions</div>
                      <div style={{ fontSize: 13, marginTop: 2, whiteSpace: 'pre-wrap' }}>
                        {draft.system_prompt}
                      </div>
                    </div>
                  )}
                  {builder?.suggested_knowledge?.length ? (
                    <div style={{ marginTop: 8 }}>
                      <div className="muted" style={{ fontSize: 12 }}>It probably needs to know</div>
                      <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
                        {builder.suggested_knowledge.map((k, i) => <li key={i}>{k}</li>)}
                      </ul>
                    </div>
                  ) : null}
                  {builder?.suggested_templates?.length ? (
                    <div style={{ marginTop: 8 }}>
                      <div className="muted" style={{ fontSize: 12 }}>Suggested integrations</div>
                      <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
                        {builder.suggested_templates.map((t) => (
                          <li key={t.id}>{t.name ?? t.id}{t.reason ? ` — ${t.reason}` : ''}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {builder?.suggested_approvals?.length ? (
                    <div style={{ marginTop: 8 }}>
                      <div className="muted" style={{ fontSize: 12 }}>Suggested approval gates</div>
                      <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
                        {builder.suggested_approvals.map((a, i) => <li key={i}>{a}</li>)}
                      </ul>
                    </div>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {step === 'knowledge' && agent && (
        <>
          {!hosted && <NotHosted />}
          {hosted && (
            <>
              {builder?.suggested_knowledge?.length ? (
                <div className="card" style={{ marginTop: 12 }}>
                  <strong>What it needs to know</strong>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    From the purpose draft — turn each into a knowledge line,
                    a document, or a website source below.
                  </div>
                  <ul style={{ margin: '8px 0', paddingLeft: 18, fontSize: 13 }}>
                    {builder.suggested_knowledge.map((k, i) => <li key={i}>{k}</li>)}
                  </ul>
                </div>
              ) : null}
              <KnowledgeTextSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
              <KnowledgeFiles agentId={agent.id} variant="files" />
              <KnowledgeFiles agentId={agent.id} variant="websites" />
            </>
          )}
        </>
      )}

      {step === 'behavior' && agent && (
        <>
          {!hosted && <NotHosted />}
          {hosted && (
            <>
              <InstructionsSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
              <GreetingSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
              <LlmCard agent={agent} cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
            </>
          )}
        </>
      )}

      {step === 'actions' && agent && (
        <>
          {!hosted && <NotHosted />}
          {hosted && (
            <>
              <div className="card" style={{ marginTop: 12 }}>
                <strong>What can it actually do?</strong>
                <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                  Connect an integration and the agent can act — look up orders,
                  issue refunds, cancel subscriptions. Every action can require a
                  teammate's approval before it runs: the agent asks, a human
                  approves, the action executes, and the conversation continues.
                </div>
                {builder?.suggested_approvals?.length ? (
                  <div style={{ marginTop: 8, fontSize: 13 }}>
                    <span className="muted">Suggested approval gates: </span>
                    {builder.suggested_approvals.map((a, i) => (
                      <span key={i} className="badge" style={{ marginRight: 4 }}>{a}</span>
                    ))}
                  </div>
                ) : null}
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Handoff to a human is always available — escalation timing and
                  routing live in{' '}
                  <Link to={`/agents/${agent.id}/settings?sub=escalation`}>Agent settings → Escalation</Link>.
                </div>
              </div>
              <ToolsTab cfg={cfg} setCfg={setCfg} agentId={agent.id} isAdmin={isAdmin} />
            </>
          )}
        </>
      )}

      {step === 'test' && agent && (
        <>
          {!hosted && <NotHosted />}
          {hosted && (
            <>
              <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>
                A real conversation on a private test channel — same pipeline as
                production. Try the knowledge you added, ask it to take an
                action, and watch approval cards pause for a human.
              </div>
              <div className="card builder-chat" style={{ marginTop: 10, padding: 0 }}>
                {testChannel.isPending && (
                  <div className="muted" style={{ padding: 14 }}>Opening test channel…</div>
                )}
                {testChannel.isError && (
                  <div className="error" style={{ margin: 14 }}>
                    {(testChannel.error as Error).message}
                  </div>
                )}
                {testChannel.data && (
                  <AskJanis channelId={testChannel.data.channel_id} badge="TEST" />
                )}
              </div>
            </>
          )}
        </>
      )}

      {step === 'deploy' && agent && (
        <>
          <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>
            Put the agent to work — add a channel and it's live. Each channel
            lands on its own configuration page after creation.
          </div>
          {hosted ? (
            <AgentChannels agent={agent} />
          ) : (
            <div className="card" style={{ marginTop: 12 }}>
              <strong>External webhook</strong>
              <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                This agent's replies come from your backend. Point it at your
                webhook URL and secret in{' '}
                <Link to={`/agents/${agent.id}/settings?sub=general`}>Agent settings → General</Link>,
                then register the URL on the channel that forwards events to it.
              </div>
            </div>
          )}
        </>
      )}

      {agent && (step !== 'test' && step !== 'deploy' && step !== 'actions') && hosted && (
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <button
            className="btn primary"
            disabled={saveCfg.isPending || !isAdmin}
            onClick={() => saveCfg.mutate()}
          >
            {saveCfg.isPending ? 'Saving…' : 'Save configuration'}
          </button>
          {next && (
            <button className="btn" onClick={() => goStep(next.key)}>
              Next: {next.label} →
            </button>
          )}
        </div>
      )}
      {agent && !hosted && step !== 'purpose' && next && (
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => goStep(next.key)}>Next: {next.label} →</button>
        </div>
      )}
    </>
  );
}

function NotHosted() {
  return (
    <div className="card muted" style={{ marginTop: 12, fontSize: 13 }}>
      This stage applies to agents Janis answers for — external-webhook agents
      generate replies on your own backend.
    </div>
  );
}
