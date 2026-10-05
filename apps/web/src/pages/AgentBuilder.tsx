import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  ToolsTab,
} from './AgentDetail';

/** Guided agent builder — Create → Teach it → Guide it → Abilities →
 *  Try it → Deploy. No configuration vocabulary: the user teaches Janis
 *  what the agent should do, and each stage is the same surface the agent's
 *  workspace exposes afterwards. Not a rigid form — stages are click-through
 *  and edits save to the live agent as you go. */
interface BuilderDraft {
  generated?: boolean;
  note?: string;
  name?: string;
  system_prompt?: string;
  tone?: string;
  greeting?: string;
  summary?: string;
}

const STEPS = [
  { key: 'create', label: 'Create', hint: 'what it does' },
  { key: 'teach', label: 'Teach it', hint: 'what it knows' },
  { key: 'guide', label: 'Guide it', hint: 'how it behaves' },
  { key: 'abilities', label: 'Abilities', hint: 'what it can do' },
  { key: 'try', label: 'Try it', hint: 'prove it works' },
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
  // 'start'/'bring' are pre-builder branches: the path choice, and the
  // external-agent create. Neither shows the six-step rail — the user
  // hasn't entered (or isn't entering) the build flow at those points.
  const step: StepKey | 'start' | 'bring' = STEPS.some((s) => s.key === stepParam)
    ? (stepParam as StepKey)
    : stepParam === 'bring'
      ? 'bring'
      : agent
        ? 'teach'
        : 'start';
  const goStep = (s: StepKey | 'start' | 'bring') => {
    navigate(`/agents/new${agent ? `/${agent.id}` : ''}?step=${s}`, { replace: true });
  };

  // Create stage — name + natural-language description → POST
  // /api/agents/bootstrap creates the agent with a generated draft config.
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<BuilderDraft | null>(null);
  const create = useMutation({
    mutationFn: (hosted: boolean) =>
      api<{ agent: Agent; draft?: BuilderDraft }>('/api/agents/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim() || undefined,
          purpose: hosted ? purpose.trim() || undefined : undefined,
          hosted,
        }),
      }),
    onSuccess: (r) => {
      setDraft(r.draft ?? null);
      setLastAgent(r.agent.id);
      void qc.invalidateQueries({ queryKey: ['agents'] });
      if (!r.agent.hosted) {
        // External agent — the builder's teach/guide/abilities don't apply;
        // webhook credentials live on the settings page.
        navigate(`/agents/${r.agent.id}/settings?sub=general`);
        return;
      }
      // Land on a confirmation card, not the draft — the create step's only
      // job is "tell Janis what you want"; the summary proves it listened.
      navigate(`/agents/new/${r.agent.id}?step=create`, { replace: true });
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

  // Try stage — the agent's test channel drives a real conversation (same
  // AskJanis pane the right rail uses); knowledge gaps the agent hits while
  // testing surface alongside it (SSE invalidates the query live).
  const testChannel = useMutation({
    mutationFn: () =>
      api<{ channel_id: string }>(`/api/agents/${agent?.id}/test-channel`, {
        method: 'POST',
      }),
  });
  useEffect(() => {
    if (step === 'try' && agent && hosted && !testChannel.data && !testChannel.isPending) {
      testChannel.mutate();
    }
  }, [step, agent?.id, hosted]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: gapData } = useQuery({
    queryKey: ['knowledge-gaps', agent?.id],
    queryFn: () =>
      api<{ gaps: { key: string; count: number; questions: string[]; added: boolean }[] }>(
        `/api/agents/${agent?.id}/knowledge-gaps`,
      ),
    enabled: Boolean(agent && hosted && step === 'try'),
  });
  const openGaps = (gapData?.gaps ?? []).filter((g) => !g.added);

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

      {step !== 'start' && step !== 'bring' && (
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
      )}

      {error && <div className="error">{error}</div>}
      {saved && <div className="muted" style={{ margin: '6px 0' }}>Saved ✓</div>}

      {step === 'start' && !agent && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>How do you want to get started?</strong>
          <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'stretch', flexWrap: 'wrap' }}>
            <button className="builder-path" onClick={() => goStep('create')}>
              <strong>Build an agent with Janis</strong>
              <span className="muted" style={{ fontSize: 13 }}>
                Start with an idea and let Janis build the foundation.
              </span>
            </button>
            <button className="builder-path" onClick={() => goStep('bring')}>
              <strong>Bring an existing agent</strong>
              <span className="muted" style={{ fontSize: 13 }}>
                Connect an agent you've already built.
              </span>
            </button>
          </div>
        </div>
      )}

      {step === 'bring' && !agent && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>Bring an existing agent</strong>
          <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
            Your own backend answers inbound messages via webhook; Janis
            carries the conversation layer — inbox, human takeover, alerts,
            and escalation. You'll set the webhook URL on the next screen.
          </div>
          <input
            className="input"
            style={{ width: '100%', marginTop: 12, boxSizing: 'border-box' }}
            placeholder="Agent name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="row" style={{ marginTop: 14, gap: 8 }}>
            <button
              className="btn primary"
              disabled={create.isPending || isAdmin === false || !name.trim()}
              onClick={() => create.mutate(false)}
            >
              {create.isPending ? 'Adding…' : 'Add agent'}
            </button>
            <button className="btn" onClick={() => goStep('start')}>← Back</button>
          </div>
        </div>
      )}

      {step === 'create' && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>Create your agent</strong>
          {!agent ? (
            <>
              <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                What should this agent do? Describe the job in your own words —
                Janis drafts a starting configuration (instructions, greeting,
                the integrations and approval gates it probably needs) and you
                refine it in the next stages.
              </div>
              <textarea
                rows={5}
                style={{ width: '100%', marginTop: 12, boxSizing: 'border-box' }}
                placeholder={
                  'Describe the job you want your agent to do…\n\ne.g. "Handle customer ' +
                  'support for my ecommerce store. Answer questions about orders ' +
                  'and shipping, and help customers with refunds."'
                }
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              />
              <input
                className="input"
                style={{ width: '100%', marginTop: 10, boxSizing: 'border-box' }}
                placeholder="Agent name (optional — we can name it for you)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <div className="row" style={{ marginTop: 14, gap: 8 }}>
                <button
                  className="btn primary"
                  disabled={create.isPending || isAdmin === false}
                  title={purpose.trim() ? '' : 'No description — creates a blank agent you teach yourself'}
                  onClick={() => create.mutate(true)}
                >
                  {create.isPending ? 'Building agent…' : 'Create agent'}
                </button>
                <button className="btn" onClick={() => goStep('start')}>← Back</button>
              </div>
              {create.isPending && purpose.trim() && (
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Drafting the configuration — usually a few seconds.
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize: 15, marginTop: 8 }}>
                <strong>Your agent is ready to teach</strong>
              </div>
              <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                I've created a starting point for <strong>{agent.name}</strong> based
                on what you described. You can refine it at any time.
              </div>
              {builder?.summary && (
                <div style={{ fontSize: 13, marginTop: 10 }}>
                  <span className="muted">It will: </span>
                  {builder.summary[0].toUpperCase() + builder.summary.slice(1)}
                </div>
              )}
              {builder?.suggested_templates?.length ? (
                <div style={{ fontSize: 13, marginTop: 8 }}>
                  <span className="muted">Suggested capabilities: </span>
                  {builder.suggested_templates.map((t) => t.name ?? t.id).join(' · ')}
                  {builder.suggested_approvals?.length ? ' · asks for approval when needed' : ''}
                </div>
              ) : null}
              {builder?.suggested_knowledge?.length ? (
                <div style={{ fontSize: 13, marginTop: 6 }}>
                  <span className="muted">Suggested knowledge: </span>
                  {builder.suggested_knowledge.slice(0, 5).join(' · ')}
                </div>
              ) : null}
              <div className="row" style={{ marginTop: 14, gap: 8 }}>
                <button className="btn primary" onClick={() => goStep('teach')}>
                  Teach {agent.name.length > 20 ? `${agent.name.slice(0, 20)}…` : agent.name} →
                </button>
              </div>
              {(draft || builder) && (
                <details style={{ marginTop: 12, fontSize: 13 }}>
                  <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                    See what Janis created
                  </summary>
                  <div className="card" style={{ margin: '10px 0 0', background: 'var(--bg)' }}>
                    {draft?.note && (
                      <div className="muted" style={{ fontSize: 12 }}>{draft.note}</div>
                    )}
                    {cfg.system_prompt && (
                      <div style={{ marginTop: 6 }}>
                        <div className="muted" style={{ fontSize: 12 }}>Instructions</div>
                        <div style={{ fontSize: 13, marginTop: 2, whiteSpace: 'pre-wrap' }}>
                          {cfg.system_prompt}
                        </div>
                      </div>
                    )}
                    {cfg.tone && (
                      <div style={{ marginTop: 8 }}>
                        <div className="muted" style={{ fontSize: 12 }}>Tone</div>
                        <div style={{ fontSize: 13, marginTop: 2 }}>{cfg.tone}</div>
                      </div>
                    )}
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
                </details>
              )}
            </>
          )}
        </div>
      )}

      {step === 'teach' && agent && (
        <>
          {!hosted && <NotHosted />}
          {hosted && (
            <>
              <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>
                What should your agent know? Add the information it needs to do
                its job — files, websites, pasted text, or a help center. These
                are all just sources of knowledge.
              </div>
              {builder?.suggested_knowledge?.length ? (
                <div className="card" style={{ marginTop: 12 }}>
                  <strong>Suggested knowledge topics</strong>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    From your description — fill each in below with the real
                    details (a line, a document, or a website).
                  </div>
                  <ul style={{ margin: '8px 0', paddingLeft: 18, fontSize: 13 }}>
                    {builder.suggested_knowledge.map((k, i) => <li key={i}>{k}</li>)}
                  </ul>
                </div>
              ) : null}
              <KnowledgeTextSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
              <KnowledgeFiles agentId={agent.id} variant="files" />
              <KnowledgeFiles agentId={agent.id} variant="websites" />
              <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                Have an existing help center?{' '}
                <Link to={`/agents/${agent.id}/knowledge?sub=help`}>Connect it in Knowledge → Help center</Link>
              </div>
            </>
          )}
        </>
      )}

      {step === 'guide' && agent && (
        <>
          {!hosted && <NotHosted />}
          {hosted && (
            <>
              <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>
                Anything else it should know about how to do its job? Rules,
                boundaries, tone — e.g. "always be concise", "never promise a
                refund until eligibility is verified", "ask for human approval
                before refunds over $100". Janis drafted these from your
                description.
              </div>
              <InstructionsSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
              <GreetingSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
            </>
          )}
        </>
      )}

      {step === 'abilities' && agent && (
        <>
          {!hosted && <NotHosted />}
          {hosted && (
            <>
              <div className="card" style={{ marginTop: 12 }}>
                <strong>What should your agent be able to do?</strong>
                <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                  Connect an integration and the agent can act — look up an
                  order, issue a refund, create a ticket. Every action can
                  require a teammate's approval before it runs: the agent asks,
                  a human approves, the action executes, and the conversation
                  continues.
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

      {step === 'try' && agent && (
        <>
          {!hosted && <NotHosted />}
          {hosted && (
            <>
              <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>
                Try your agent — a real conversation on a private test channel,
                same pipeline as production. Ask the questions you taught it,
                ask it to take an action, and watch approval cards pause for a
                human.
              </div>
              {openGaps.length > 0 && (
                <div className="card" style={{ marginTop: 10 }}>
                  <strong>Your agent doesn't know how to answer this</strong>
                  <ul style={{ margin: '6px 0', paddingLeft: 18, fontSize: 13 }}>
                    {openGaps.slice(0, 3).flatMap((g) => g.questions.slice(0, 1)).map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn" onClick={() => goStep('teach')}>Teach it →</button>
                    <Link className="muted" style={{ fontSize: 12, alignSelf: 'center' }}
                      to={`/agents/${agent.id}/knowledge?sub=gaps`}>
                      all knowledge gaps
                    </Link>
                  </div>
                </div>
              )}
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
            Your agent is ready — where should it work? Add a channel and it's
            live; each channel lands on its own configuration page after
            creation.
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

      {agent && (step === 'teach' || step === 'guide') && hosted && (
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
      {agent && !hosted && step !== 'create' && next && (
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
