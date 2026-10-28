import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Agent,
  AgentConfig,
  AgentMember,
  AgentSecretMeta,
  AlertRule,
  Channel,
  ToolTemplateInfo,
} from '@janis/shared';
import { DEFAULT_INTENTS } from '@janis/shared';
import { api } from '../api/client';
import { useAgentMembers, useAgents, useAlertRules, useChannels, useDeliveries, useGroups, useMe, useSavedReplies, useSlackChannels, useSlackStatus, useUsers } from '../api/hooks';
import { AgentChannels } from '../components/AgentChannels';
import { MemberGroups } from '../components/MemberGroups';
import { MemberCell, TeamRow, TeamTable, teamTd } from '../components/TeamTable';
import { SourceList } from '../components/SourceList';
import { AutosizeText, timeAgo } from '../components/bits';
import { SlackChannelSelect } from '../components/SlackChannelSelect';
import { LlmEditor, type LlmBlock } from '../components/LlmEditor';
import { ModelPicker } from '../components/ModelPicker';
import {
  METERED,
  catalogOptions,
  catalogRateFor,
  detectProvider,
  filterLiveModels,
  modelsForProvider,
  providerForVendor,
  type ModelOption,
} from '../lib/llmProviders';
import type { LlmVendor } from '@janis/shared';
import { SavedWidgets } from '../components/WidgetComposer';
import { janisBrain } from '../lib/agentContext';
import { revealScenario } from '../lib/scenarioRing';
import { railBus } from '../lib/railBus';
import { CorrectThisCard } from '../components/CorrectThis';
import { Modal } from '../components/Modal';
import { ScenarioRow, scenarioPrompt } from '../components/ScenarioRow';
import { ScenarioList, isFailing, isPassing } from '../components/ScenarioList';
import type { Filter as ScenarioFilter, ScenarioCounts, Sort as ScenarioSort } from '../components/ScenarioList';
import { useDock } from '../lib/dockContext';
import { usePageTitle } from '../lib/title';
import { NOTIFY_EVENT_LABELS } from '../lib/notifyEvents';
import { useConfirm } from '../components/Prompt';
import { FlaskConical, Pencil, Trash2, Upload, X } from 'lucide-react';

type RuleKind = AlertRule['kind'];
/** `defaultOn` kinds ping the workspace even with zero rules — a rule exists
 *  to assign or mute them, not to turn them on (mirrors evaluateEvent's
 *  fires(): no rule of the kind = on). */
const RULE_KINDS: { key: RuleKind; label: string; hint: string; defaultOn?: boolean }[] = [
  { key: 'handoff_request', label: 'Handoff request', hint: 'the agent asks for a human', defaultOn: true },
  { key: 'sentiment', label: 'Negative sentiment', hint: 'a customer message reads frustrated or angry' },
  { key: 'intent', label: 'Topic match', hint: 'the classifier tags the conversation with a topic' },
  { key: 'keyword', label: 'Keyword', hint: 'an inbound message contains the text' },
  { key: 'error', label: 'Agent error', hint: 'a tool call fails, output drops, or the run throws' },
  { key: 'csat', label: 'Low CSAT', hint: 'a survey score lands at or below the threshold' },
  { key: 'inactivity', label: 'Inactivity', hint: 'the customer waits N minutes with no reply' },
  { key: 'failure', label: 'Agent failure', hint: 'the agent reports it could not handle the message', defaultOn: true },
  { key: 'custom_alert', label: 'Custom alert', hint: 'the agent raises its own alert type', defaultOn: true },
  { key: 'auto_assign', label: 'Auto-assign', hint: 'every new conversation goes to the next pool member' },
];
const kindMeta = (k: RuleKind) => RULE_KINDS.find((x) => x.key === k);
/** Kinds with no filter params — a second rule of the same kind can never
 *  fire (first match wins the per-conversation alert). inactivity joins
 *  them despite its minutes param: the sweeper collapses an agent's
 *  inactivity rules to the smallest threshold, so tiers can't work.
 *  keyword/intent/csat stay multi — different filters match disjoint
 *  events. */
const SINGLE_RULE_KINDS = new Set<RuleKind>([
  'handoff_request',
  'sentiment',
  'error',
  'failure',
  'custom_alert',
  'auto_assign',
  'inactivity',
]);
const TEMPLATE_WEBHOOK = 'http://localhost:9798/webhook';

/** Agent config sections — one per sidebar entry. `hosted` sections are
 *  hidden (and redirect) for external-webhook agents. */
const SECTIONS = {
  behavior: 'Behavior',
  knowledge: 'Knowledge',
  channels: 'Channels',
  integrations: 'Actions',
  components: 'Chat components',
  tests: 'Test',
  settings: 'Settings',
} as const;
type Section = keyof typeof SECTIONS;
const HOSTED_ONLY: Section[] = ['knowledge', 'integrations', 'components', 'tests'];
// The URL key predates the labels — accept the label spellings too so a
// guessed or concierge-built link (/agents/<id>/experience) doesn't dump
// the user on the Channels default.
const SECTION_ALIASES: Record<string, Section> = {
  experience: 'behavior',
  actions: 'integrations',
  test: 'tests',
};

const SUB_TABS: Partial<
  Record<Section, { key: string; label: string; hosted?: boolean; externalOnly?: boolean }[]>
> = {
  behavior: [
    // Instructions + greeting + quick replies share one page — same grouping
    // as the builder's Guide-it step (InstructionsSection + GreetingSection).
    // External-webhook agents keep greeting standalone: the merged page is
    // hosted-only, and Janis still delivers their greeting row on webchat.
    { key: 'instructions', label: 'Instructions', hosted: true },
    { key: 'greeting', label: 'Greeting', externalOnly: true },
    { key: 'components', label: 'Chat components', hosted: true },
  ],
  knowledge: [
    { key: 'sources', label: 'Sources' },
    { key: 'gaps', label: 'Gaps' },
    // No Articles tab — the Sources list owns an expandable Articles row
    // with the full manager embedded; a second tab duplicated it.
  ],
  settings: [
    { key: 'general', label: 'General' },
    { key: 'csat', label: 'CSAT' },
    { key: 'escalation', label: 'Escalation' },
    { key: 'team', label: 'Team' },
  ],
};

export default function AgentDetail() {
  const { id, section: rawSection } = useParams<{ id: string; section?: string }>();
  const [searchParams] = useSearchParams();
  const { data } = useAgents();
  const agent = data?.agents.find((a) => a.id === id);
  usePageTitle(agent?.name ?? 'Agent');
  const sectionKey = rawSection && (SECTION_ALIASES[rawSection] ?? rawSection);
  const section = (sectionKey && sectionKey in SECTIONS ? sectionKey : 'channels') as Section;
  // Hosted-only sections make no sense for external-webhook agents and for
  // BYOK engines (dialogflow/monitor) where Janis doesn't write replies —
  // the sidebar hides them; direct hits bounce to Channels.
  const hostedSection = agent && !janisBrain(agent) && HOSTED_ONLY.includes(section);
  // The satisfaction survey moved to Agent settings → CSAT — old
  // behavior?sub=satisfaction links follow it instead of landing on
  // Instructions.
  const movedSurvey =
    section === 'behavior' &&
    ['satisfaction', 'csat'].includes(searchParams.get('sub') ?? '');

  if (data && !agent) {
    return (
      <>
        <h1 className="page-title">Agent not found</h1>
        <Link to="/agents" className="muted">← Back to agents</Link>
      </>
    );
  }
  if (!agent) return null;
  if (hostedSection) return <Navigate to={`/agents/${agent.id}/channels`} replace />;
  if (movedSurvey) return <Navigate to={`/agents/${agent.id}/settings?sub=csat`} replace />;
  // key remounts the editor (and its drafts) when navigating between agents
  return <AgentEditor key={agent.id} agent={agent} section={section} />;
}

function AgentEditor({ agent, section }: { agent: Agent; section: Section }) {
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
  // Sub-tab lives in the URL (?sub=…) so refresh/back/deep links keep
  // position — the section itself is the route path.
  const [params, setParams] = useSearchParams();
  const subs = (SUB_TABS[section] ?? []).filter(
    (s) =>
      (janisBrain(agent) || !s.hosted) && (!s.externalOnly || !janisBrain(agent)),
  );
  const subParam = params.get('sub');
  // Legacy deep-links: prompt/tone merged into Instructions; the old
  // per-type knowledge tabs merged into Sources; help is now Articles.
  const LEGACY_SUBS: Record<string, string> = {
    prompt: 'instructions',
    tone: 'instructions',
    ...(janisBrain(agent) ? { greeting: 'instructions' } : {}),
    websites: 'sources',
    files: 'sources',
    text: 'sources',
    help: 'sources',
    articles: 'sources',
    replies: 'escalation',
    satisfaction: 'csat',
  };
  const subKey = subParam ? (LEGACY_SUBS[subParam] ?? subParam) : subParam;
  const sub = subs.some((s) => s.key === subKey) ? subKey! : (subs[0]?.key ?? '');
  const setSub = (s: string) =>
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (s === subs[0]?.key) p.delete('sub');
      else p.set('sub', s);
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

  // draft state — name lives in Settings → General; cfg is one shared draft
  // saved wholesale by the bottom Save button
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
    // build progress is derived from config/channels — keep it fresh too
    void qc.invalidateQueries({ queryKey: ['build-status'] });
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
    mutationFn: (cancelSub: boolean) =>
      api<{ legacy_sub_canceled?: boolean; legacy_sub_retained?: boolean; legacy_sub_siblings?: number }>(
        `/api/agents/${agent.id}${cancelSub ? '?cancel_subscription=1' : ''}`,
        { method: 'DELETE' },
      ),
    onSuccess: async (r) => {
      if (r.legacy_sub_canceled) {
        const shared = r.legacy_sub_siblings ?? 0;
        await confirm(
          shared > 0
            ? `Deleted — the legacy subscription was canceled. ${shared} other bot${shared === 1 ? ' was' : 's were'} on that subscription; their billing has ended too.`
            : 'Deleted — the legacy subscription was canceled.',
          [{ key: 'ok', label: 'OK' }],
        );
      } else if (r.legacy_sub_retained) {
        const shared = r.legacy_sub_siblings ?? 0;
        await confirm(
          shared > 0
            ? `Deleted — the legacy subscription was NOT canceled; it still bills ${shared} other bot${shared === 1 ? '' : 's'}. Cancel it when the last bot on it is gone.`
            : 'Deleted — the legacy subscription was NOT canceled; it keeps billing until you cancel it.',
          [{ key: 'ok', label: 'OK' }],
        );
      }
      navigate('/agents');
    },
    onError: (e) => setError(e.message),
  });

  const convertHosted = useMutation({
    mutationFn: () =>
      api<{ imported: number; phrases: number }>(`/api/agents/${agent.id}/convert-hosted`, {
        method: 'POST',
      }),
    onSuccess: async (r) => {
      refresh();
      await confirm(
        `Converted — ${r.imported} Dialogflow intents (${r.phrases} phrases) imported into Knowledge. The Dialogflow agent is untouched; rollback is available here.`,
        [{ key: 'ok', label: 'OK' }],
      );
    },
    onError: (e) => setError(e.message),
  });

  const rollbackLegacy = useMutation({
    mutationFn: () => api(`/api/agents/${agent.id}/rollback-legacy`, { method: 'POST' }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  const retryLegacyEngine = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; project?: string }>(`/api/agents/${agent.id}/retry-legacy-engine`, {
        method: 'POST',
      }),
    onSuccess: async (r) => {
      refresh();
      await confirm(
        `Dialogflow connected — this agent now answers on its legacy engine (project ${r.project}).`,
        [{ key: 'ok', label: 'OK' }],
      );
    },
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

  const updateRule = useMutation({
    mutationFn: (body: { id: string; config: Record<string, unknown> }) =>
      api(`/api/rules/${body.id}`, { method: 'PATCH', body: JSON.stringify({ config: body.config }) }),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  const rules = rulesData?.rules.filter((r) => r.agent_id === agent.id) ?? [];
  const channels = channelsData?.channels.filter((c) => c.agent_id === agent.id) ?? [];

  const saveAll = () =>
    update.mutate({
      ...(name.trim() && name.trim() !== agent.name ? { name: name.trim() } : {}),
      ...(agent.hosted ? {} : { webhook_url: webhookUrl || null }),
      auto_resume_minutes: autoResume ? Number(autoResume) : null,
      config: cfg,
    });

  // Sections whose edits live in the shared draft — the bottom Save button
  // renders there. Knowledge self-saves per row now (the unified source
  // list writes each change immediately); Settings shows it on every sub —
  // its drafts span General (name, webhook URL) and Escalation
  // (auto-resume), and Team/Saved-replies cards self-save but the shared
  // save still applies.
  const hasDrafts = section === 'behavior' || section === 'settings';

  return (
    <div className="agent-editor">
      <div className="agent-head">
        <div className="row" style={{ alignItems: 'center' }}>
          {backToConv && (
            <Link
              to={backToConv}
              style={{ color: 'var(--accent)', fontSize: 13, whiteSpace: 'nowrap' }}
              title="Return to the conversation at the same scroll spot"
            >
              ← conversation
            </Link>
          )}
          <h1 className="page-title grow" style={{ minWidth: 0 }}>{agent.name}</h1>
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
          <button
            className="btn primary"
            title="Channels, widget, embed — put this agent to work"
            onClick={() => navigate(`/agents/${agent.id}/channels`)}
          >
            Channels
          </button>
        </div>
        <div className="muted" style={{ marginTop: 10 }}>
          {agent.last_seen_at ? `last event ${timeAgo(agent.last_seen_at)}` : 'no events yet'}
          {channels.length > 0 && ` · channels: ${channels.map((c) => c.name).join(', ')}`}
          {janisBrain(agent) && (
            <>
              {' · '}
              <Link to={`/agents/${agent.id}/tests`}>scenarios</Link>
            </>
          )}
        </div>
        {subs.length > 0 && (
          <div className="tabs">
            {subs.map((t) => (
              <button
                key={t.key}
                className={`tab${sub === t.key ? ' active' : ''}`}
                onClick={() => setSub(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {confirmEl}
      {error && <div className="error">{error}</div>}

      {section === 'channels' && <AgentChannels agent={agent} />}
      {section === 'integrations' && janisBrain(agent) && (
        <ToolsTab cfg={cfg} setCfg={setCfg} agentId={agent.id} isAdmin={isAdmin} />
      )}
      {/* Legacy /components route still renders standalone; the canonical
          home is now the Behavior → Chat components sub-tab. */}
      {(section === 'components' || (section === 'behavior' && sub === 'components')) &&
        janisBrain(agent) && (
        <SavedWidgets agentId={agent.id} isAdmin={isAdmin} tools={cfg.tools ?? []} />
      )}
      {section === 'tests' && janisBrain(agent) && <TestsTab agentId={agent.id} agent={agent} isAdmin={isAdmin} />}
      {section === 'behavior' && (
        <>
          {sub === 'instructions' && janisBrain(agent) && (
            <InstructionsSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
          )}
          {/* 'greeting' is the external-webhook agents' own sub — the merged
              page is hosted-only, but Janis still delivers their greeting. */}
          {(sub === 'instructions' || sub === 'greeting') && (
            <GreetingSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
          )}
          {sub === 'instructions' && janisBrain(agent) && (
            <ProceduresSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
          )}
          {sub === 'instructions' && janisBrain(agent) && (
            <CollectSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
          )}
        </>
      )}
      {section === 'knowledge' && janisBrain(agent) && (
        <>
          {sub === 'sources' && (
            <SourceList
              agentId={agent.id}
              agent={agent}
              cfg={cfg}
              isAdmin={isAdmin}
              onConfigSaved={(config) =>
                api(`/api/agents/${agent.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ config }),
                }).then(() => {
                  setCfg(config);
                  refresh();
                })
              }
              articlesExtras={
                <label
                  className="row muted"
                  style={{ fontSize: 12, marginTop: 6, gap: 6, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={!!cfg.builder?.include_drafts_in_test}
                    disabled={update.isPending}
                    onChange={(e) => {
                      const config: AgentConfig = {
                        ...cfg,
                        builder: {
                          ...cfg.builder,
                          include_drafts_in_test: e.target.checked,
                        },
                      };
                      setCfg(config);
                      update.mutate({ config });
                    }}
                  />
                  Include draft articles in test chats — production always
                  injects published only
                </label>
              }
            />
          )}
          {sub === 'gaps' && <KnowledgeGaps agentId={agent.id} config={agent.config ?? {}} />}
        </>
      )}
      {section === 'settings' && (
        <>
          {sub === 'general' && (
            <>
              <ConnectionTab
                agent={agent}
                isAdmin={isAdmin}
                name={name}
                setName={setName}
                webhookUrl={webhookUrl}
                setWebhookUrl={setWebhookUrl}
                onSaveHosted={(hosted) => update.mutate({ hosted })}
                onTestWebhook={() => testWebhook.mutate()}
              />
              {janisBrain(agent) && (
                <LlmCard agent={agent} cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
              )}
              <CredentialsCard
                agent={agent}
                isAdmin={isAdmin}
                onRotateKey={() => rotateKey.mutate()}
                onRotateSecret={() => rotateSecret.mutate()}
                onRevealSecret={async () => {
                  const r = await api<{ webhook_secret: string }>(`/api/agents/${agent.id}/webhook-secret`);
                  setFreshSecret({ label: 'Webhook secret', value: r.webhook_secret });
                }}
                freshSecret={freshSecret}
              />
              <HelpDomainCard cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
            </>
          )}
          {sub === 'escalation' && (
            <EscalationTab
              agent={agent}
              cfg={cfg}
              setCfg={setCfg}
              autoResume={autoResume}
              setAutoResume={setAutoResume}
              rules={rules}
              isAdmin={isAdmin}
              onAddRule={(kind, config) => addRule.mutate({ kind, config })}
              onUpdateRule={(id, config) => updateRule.mutate({ id, config })}
              onDeleteRule={(rid) => deleteRule.mutate(rid)}
            />
          )}
          {sub === 'csat' && (
            <SatisfactionSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
          )}
          {sub === 'team' && <TeamSection agent={agent} isAdmin={isAdmin} />}
        </>
      )}

      {isAdmin && hasDrafts && (
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          {section === 'settings' &&
            (agent.config as { engine?: string } | null)?.engine === 'monitor' &&
            !!(agent.metadata as { legacy_client_key?: string } | undefined)?.legacy_client_key && (
            <button
              className="btn"
              disabled={retryLegacyEngine.isPending}
              title="Re-check the legacy bot for Dialogflow credentials — use after re-connecting Dialogflow on the legacy dashboard"
              onClick={async () => {
                if (await confirm('Retry importing this agent\'s Dialogflow credentials from the legacy setup?', [{ key: 'ok', label: 'Retry import' }, { key: 'cancel', label: 'Cancel' }]) === 'ok') retryLegacyEngine.mutate();
              }}
            >
              {retryLegacyEngine.isPending ? 'Retrying…' : 'Retry Dialogflow import'}
            </button>
          )}
          {section === 'settings' && (agent.config as { engine?: string } | null)?.engine === 'dialogflow' && (
            <button
              className="btn"
              disabled={convertHosted.isPending}
              onClick={async () => {
                if (await confirm('Convert to a hosted agent? Its Dialogflow intents import into Knowledge and Janis becomes the brain — the Dialogflow agent stays intact for rollback. Billing is unchanged: any legacy subscription keeps billing until you cancel it.', [{ key: 'ok', label: 'Convert' }, { key: 'cancel', label: 'Cancel' }]) === 'ok') convertHosted.mutate();
              }}
            >
              {convertHosted.isPending ? 'Converting…' : 'Convert to hosted'}
            </button>
          )}
          {section === 'settings' && !!(agent.metadata as Record<string, unknown> | undefined)?.legacy_engine && (
            <button
              className="btn"
              disabled={rollbackLegacy.isPending}
              onClick={async () => {
                if (await confirm('Revert to the legacy Dialogflow engine? The imported knowledge stays but the bot answers via Dialogflow again.', [{ key: 'ok', label: 'Revert' }, { key: 'cancel', label: 'Cancel' }]) === 'ok') rollbackLegacy.mutate();
              }}
            >
              {rollbackLegacy.isPending ? 'Reverting…' : 'Revert to legacy engine'}
            </button>
          )}
          {section === 'settings' && (
            <button
              className="btn danger"
              onClick={async () => {
                const hasLegacySub = !!(agent.metadata as { legacy_stripe?: { subscription_id?: string } } | undefined)
                  ?.legacy_stripe?.subscription_id;
                const choice = hasLegacySub
                  ? await confirm(
                      `Delete agent "${agent.name}"? Its channels, conversations, and settings are removed. This bot has an active legacy subscription — deleting does NOT stop billing. Only cancel the subscription when this is the last bot on it.`,
                      [
                        { key: 'keep', label: 'Delete — keep billing', danger: true },
                        { key: 'cancel_sub', label: 'Delete & cancel subscription', danger: true },
                      ],
                    )
                  : await confirm(
                      `Delete agent "${agent.name}"? Its channels, conversations, and settings are removed.`,
                      [{ key: 'ok', label: 'Delete', danger: true }],
                    );
                if (choice) removeAgent.mutate(choice === 'cancel_sub');
              }}
            >
              Delete agent
            </button>
          )}
          {hasDrafts && (
            <button className="btn primary" disabled={update.isPending} onClick={saveAll}>
              {update.isPending ? 'Saving…' : savedFlash ? 'Saved ✓' : 'Save'}
            </button>
          )}
        </div>
      )}
    </div>
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
  const [msg, setMsg] = useState(
    new URLSearchParams(window.location.search).get('slack') === 'connected'
      ? 'Slack connected.'
      : '',
  );
  // OAuth returns here — the API lands the installer back on the ?return path.
  const slackInstallHref = `/api/slack/install?return=${encodeURIComponent(
    window.location.pathname + window.location.search,
  )}`;
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
            <a className="btn primary" style={{ display: 'inline-block', marginTop: 8 }} href={slackInstallHref}>Connect Slack</a>
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
                <a className="btn" href={slackInstallHref}>Add workspace</a>
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
                  <a className="btn" href={slackInstallHref}>Add workspace</a>
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

/** A textarea-backed cfg field that follows external writes (concierge
 *  approvals, teammate saves via SSE refetch) unless the user has diverged
 *  from the last server value — the in-progress edit wins. */
function useSyncedText(
  cfg: AgentConfig,
  key: 'knowledge' | 'quick_replies',
  join: (v: unknown) => string,
): [string, (v: string) => void] {
  const [text, setText] = useState(() => join(cfg[key]));
  const base = join(cfg[key]);
  const baseRef = useRef(base);
  useEffect(() => {
    if (base === baseRef.current) return;
    setText((cur) => (cur === baseRef.current ? base : cur));
    baseRef.current = base;
  }, [base]);
  return [text, setText];
}
const joinLines = (v: unknown) => (Array.isArray(v) ? (v as string[]).join('\n') : '');
const joinCsv = (v: unknown) => (Array.isArray(v) ? (v as string[]).join(', ') : '');

export function GreetingSection({
  cfg,
  setCfg,
  isAdmin,
}: {
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  isAdmin: boolean;
}) {
  const [repliesText, setRepliesText] = useSyncedText(cfg, 'quick_replies', joinCsv);
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
      <strong>Greeting</strong>
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
            reply buttons on Messenger/IG/WhatsApp greetings). Max 20 chars each — Meta
            shortens anything longer.
          </label>
          <input
            placeholder='e.g. "Pricing", "Hours", "Talk to a human"'
            value={repliesText}
            onChange={(e) => setRepliesText(e.target.value)}
            onBlur={() =>
              setCfg({
                ...cfg,
                quick_replies: repliesText.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
              })
            }
          />
          {(() => {
            const over = repliesText
              .split(/[,\n]/)
              .map((s) => s.trim())
              .filter((s) => [...s].length > 20);
            return over.length ? (
              <span className="muted" style={{ fontSize: 12, color: 'var(--warn, #f59e0b)' }}>
                {over.length} over 20 chars — Meta will shorten {over.length === 1 ? 'it' : 'them'}
              </span>
            ) : null;
          })()}
        </>
      )}
      </ReadOnly>
    </div>
  );
}

/** Instructions — the system prompt plus the tone override, one card. */
export function InstructionsSection({
  cfg,
  setCfg,
  isAdmin,
}: {
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  isAdmin: boolean;
}) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, flex: 1 }}>
      <strong>Instructions</strong>
      <ReadOnly off={!isAdmin}>
      <label>
        Who the agent is, what it covers, and the rules it follows — persona,
        scope, when to bring in a human. Facts and policies belong in the
        knowledge base, not here.
      </label>
      <textarea
        rows={8}
        style={{ flex: 1, resize: 'none' }}
        placeholder="You are the support agent for Acme Co. You help with orders, returns…"
        value={cfg.system_prompt ?? ''}
        onChange={(e) => setCfg({ ...cfg, system_prompt: e.target.value })}
      />
      <label>Tone</label>
      <textarea
        rows={3}
        placeholder="e.g. warm, concise, never apologetic"
        value={cfg.tone ?? ''}
        onChange={(e) => setCfg({ ...cfg, tone: e.target.value })}
      />
      </ReadOnly>
    </div>
  );
}

/** Steps editor — one row per step: the instruction plus an optional tool
 *  binding (the model is then REQUIRED to call that tool for the step).
 *  Emits plain strings for unbound steps, {text, tool} for bound ones. */
function StepsEditor({
  steps,
  tools,
  onChange,
}: {
  steps: (string | { text: string; tool?: string })[];
  tools: string[];
  onChange: (steps: (string | { text: string; tool?: string })[]) => void;
}) {
  const rows = steps.map((s) => (typeof s === 'string' ? { text: s } : s));
  const emit = (next: { text: string; tool?: string }[]) =>
    onChange(next.map((s) => (s.tool ? s : s.text)));
  const setRow = (i: number, patch: Partial<{ text: string; tool?: string }>) =>
    emit(rows.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((s, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="muted" style={{ width: 18, fontSize: 12 }}>{i + 1}.</span>
          <input
            style={{ flex: 1 }}
            placeholder="e.g. Ask for the order number"
            value={s.text}
            onChange={(e) => setRow(i, { text: e.target.value })}
          />
          <select
            style={{ width: 190 }}
            value={s.tool ?? ''}
            title="Tool this step must call"
            onChange={(e) => setRow(i, { tool: e.target.value || undefined })}
          >
            <option value="">no tool</option>
            {tools.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
            {s.tool && !tools.includes(s.tool) && (
              <option value={s.tool}>{s.tool} (removed)</option>
            )}
          </select>
          <button
            className="ghost"
            type="button"
            onClick={() => emit(rows.filter((_, j) => j !== i))}
            aria-label="Remove step"
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="ghost"
        type="button"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => emit([...rows, { text: '' }])}
      >
        + Add step
      </button>
    </div>
  );
}

/** Procedures — authored runbooks the agent runs stepwise when a request
 *  matches the trigger (returns, warranty, intake). */
export function ProceduresSection({
  cfg,
  setCfg,
  isAdmin,
}: {
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  isAdmin: boolean;
}) {
  const procs = cfg.procedures ?? [];
  const update = (i: number, patch: Partial<NonNullable<AgentConfig['procedures']>[number]>) =>
    setCfg({ ...cfg, procedures: procs.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
      <strong>Procedures</strong>
      <span className="muted" style={{ fontSize: 13 }}>
        Step-by-step workflows the agent follows in order when a request matches — returns,
        warranty intake, onboarding. Steps can bind a tool — pick one per step and the agent is required to call it there (e.g. shopify_lookup_order).
        Rules and policies still belong in Instructions and knowledge.
      </span>
      <ReadOnly off={!isAdmin}>
        {procs.map((p, i) => (
          <div
            key={i}
            style={{
              border: '1px solid var(--border, #e5e7eb)',
              borderRadius: 8,
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 1 }}
                placeholder="Name — e.g. Returns & exchanges"
                value={p.name}
                onChange={(e) => update(i, { name: e.target.value })}
              />
              <button className="ghost" type="button" onClick={() =>
                setCfg({ ...cfg, procedures: procs.filter((_, j) => j !== i) })
              }>
                Remove
              </button>
            </div>
            <input
              placeholder="Use when — e.g. the customer wants to return or exchange an item"
              value={p.when ?? ''}
              onChange={(e) => update(i, { when: e.target.value })}
            />
            <StepsEditor
              steps={p.steps}
              tools={(cfg.tools ?? []).map((t) => t.name)}
              onChange={(steps) => update(i, { steps })}
            />
          </div>
        ))}
        {procs.length < 12 && (
          <button
            className="ghost"
            type="button"
            onClick={() =>
              setCfg({
                ...cfg,
                procedures: [...procs, { name: '', when: '', steps: [] }],
              })
            }
          >
            + Add procedure
          </button>
        )}
      </ReadOnly>
    </div>
  );
}

type CollectFormCfg = NonNullable<AgentConfig['collect_forms']>[number];
type CollectField = CollectFormCfg['fields'][number];

/** Collect-data actions — named chat forms whose submissions land as
 *  structured data: the visitor's message plus contact enrichment, tags,
 *  and webhook/email destinations. */
export function CollectSection({
  cfg,
  setCfg,
  isAdmin,
}: {
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  isAdmin: boolean;
}) {
  const forms = cfg.collect_forms ?? [];
  const write = (next: CollectFormCfg[]) => setCfg({ ...cfg, collect_forms: next });
  const update = (i: number, patch: Partial<CollectFormCfg>) =>
    write(forms.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const setField = (fi: number, i: number, patch: Partial<CollectField>) =>
    update(fi, {
      fields: forms[fi].fields.map((f, j) => (j === i ? { ...f, ...patch } : f)),
    });
  const blankField = (): CollectField => ({ name: '', label: '', type: 'text' });
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
      <strong>Collect data</strong>
      <span className="muted" style={{ fontSize: 13 }}>
        Named forms the agent can present in chat — lead capture, intake, return details.
        A submission arrives as the visitor's message AND as data: it fills the contact,
        applies tags, and posts to your destinations (webhook, email). Fields of type
        email / phone / a field named "name" map onto the contact record; the rest are
        saved as stated details.
      </span>
      <ReadOnly off={!isAdmin}>
        {forms.map((f, fi) => (
          <div
            key={fi}
            style={{
              border: '1px solid var(--border, #e5e7eb)',
              borderRadius: 8,
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 1 }}
                placeholder="Name — e.g. lead_capture (letters, digits, _)"
                value={f.name}
                onChange={(e) => update(fi, { name: e.target.value })}
              />
              <button className="ghost" type="button" onClick={() => write(forms.filter((_, j) => j !== fi))}>
                Remove
              </button>
            </div>
            <input
              placeholder="Use when — e.g. a shopper wants to be notified or quoted"
              value={f.when ?? ''}
              onChange={(e) => update(fi, { when: e.target.value })}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 2 }}
                placeholder="Form title — shown above the fields"
                value={f.title ?? ''}
                onChange={(e) => update(fi, { title: e.target.value })}
              />
              <input
                style={{ flex: 1 }}
                placeholder="Submit label (Submit)"
                value={f.submit_label ?? ''}
                onChange={(e) => update(fi, { submit_label: e.target.value })}
              />
            </div>
            {f.fields.map((fd, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  style={{ flex: 1 }}
                  placeholder="field_name"
                  value={fd.name}
                  onChange={(e) => setField(fi, i, { name: e.target.value })}
                />
                <input
                  style={{ flex: 2 }}
                  placeholder="Label — shown to the visitor"
                  value={fd.label}
                  onChange={(e) => setField(fi, i, { label: e.target.value })}
                />
                <select
                  value={fd.type ?? 'text'}
                  onChange={(e) => setField(fi, i, { type: e.target.value as CollectField['type'] })}
                >
                  {(['text', 'email', 'tel', 'textarea', 'select'] as const).map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <label className="check-label" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={!!fd.required}
                    onChange={(e) => setField(fi, i, { required: e.target.checked || undefined })}
                  />
                  req
                </label>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => update(fi, { fields: f.fields.filter((_, j) => j !== i) })}
                  aria-label="Remove field"
                >
                  ×
                </button>
              </div>
            ))}
            {f.fields.some((fd) => fd.type === 'select') &&
              f.fields.map((fd, i) =>
                fd.type === 'select' ? (
                  <input
                    key={`opts-${i}`}
                    placeholder={`Options for "${fd.name || 'select'}" — comma separated`}
                    value={(fd.options ?? []).join(', ')}
                    onChange={(e) =>
                      setField(fi, i, {
                        options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean),
                      })
                    }
                  />
                ) : null,
              )}
            <div>
              <button
                className="ghost"
                type="button"
                disabled={f.fields.length >= 8}
                onClick={() => update(fi, { fields: [...f.fields, blankField()] })}
              >
                + Add field
              </button>
            </div>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <label className="check-label" style={{ fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={f.contact !== false}
                  onChange={(e) => update(fi, { contact: e.target.checked ? undefined : false })}
                />
                Save to contact
              </label>
              <input
                style={{ flex: 1, minWidth: 140 }}
                placeholder="Tags — comma separated"
                value={(f.tags ?? []).join(', ')}
                onChange={(e) =>
                  update(fi, {
                    tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean),
                  })
                }
              />
            </div>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <input
                style={{ flex: 2, minWidth: 180 }}
                placeholder="Webhook URL — POSTs the submission JSON (optional)"
                value={f.webhook_url ?? ''}
                onChange={(e) => update(fi, { webhook_url: e.target.value || undefined })}
              />
              <input
                style={{ flex: 1, minWidth: 140 }}
                placeholder="Notify email (optional)"
                value={f.email ?? ''}
                onChange={(e) => update(fi, { email: e.target.value || undefined })}
              />
            </div>
          </div>
        ))}
        {forms.length < 8 && (
          <button
            className="ghost"
            type="button"
            onClick={() =>
              write([...forms, { name: '', fields: [blankField()] }])
            }
          >
            + Add form
          </button>
        )}
      </ReadOnly>
    </div>
  );
}

/** Satisfaction survey + resolution flow — the csat override card plus the
 *  auto-archive override that fires the survey when the customer confirms
 *  they're done. Both follow workspace defaults until overridden. */
function SatisfactionSection({
  cfg,
  setCfg,
  isAdmin,
}: {
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  isAdmin: boolean;
}) {
  const { data: ws } = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      api<{ workspace: { auto_archive?: boolean | null } }>('/api/workspace'),
  });
  const wsDefault = ws?.workspace.auto_archive === true;
  return (
    <>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <strong>Resolution</strong>
        <div className="muted" style={{ fontSize: 12 }}>
          Auto-archive signs off and closes the thread once the customer
          confirms they're done — firing the CSAT survey. Overrides the
          workspace default (currently {wsDefault ? 'on' : 'off'}) for this
          agent.
        </div>
        <ReadOnly off={!isAdmin}>
        <label className="check-label">
          <input
            type="checkbox"
            checked={cfg.auto_archive !== undefined}
            onChange={(e) =>
              setCfg({
                ...cfg,
                auto_archive: e.target.checked ? true : undefined,
              })
            }
          />
          Override workspace default for this agent
        </label>
        {cfg.auto_archive !== undefined && (
          <select
            value={cfg.auto_archive ? 'on' : 'off'}
            onChange={(e) =>
              setCfg({ ...cfg, auto_archive: e.target.value === 'on' })
            }
          >
            <option value="on">On — sign off and archive when the customer confirms</option>
            <option value="off">Off — the thread stays open</option>
          </select>
        )}
        </ReadOnly>
      </div>
      <SatisfactionCard cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
    </>
  );
}

// The stock fallbacks — mirrored from the API's csat.ts so the override
// card can show the text the workspace is actually inheriting.
const STOCK_CSAT_PROMPT =
  'How was your experience? Reply with a rating from 1 (poor) to 5 (great).';
const STOCK_CSAT_THANKS = 'Thanks for the feedback!';

/** CSAT override card — shared between Settings/escalation history and the
 *  Behavior → Satisfaction tab. */
function SatisfactionCard({
  cfg,
  setCfg,
  isAdmin,
}: {
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  isAdmin: boolean;
}) {
  const { data: ws } = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      api<{ workspace: { csat?: { enabled?: boolean; prompt?: string; thanks?: string } | null } }>(
        '/api/workspace',
      ),
  });
  const wsCsat = ws?.workspace.csat ?? {};
  const wsOn = wsCsat.enabled ?? true;
  const wsPrompt = wsCsat.prompt ?? STOCK_CSAT_PROMPT;
  const wsThanks = wsCsat.thanks ?? STOCK_CSAT_THANKS;
  return (
      <div className="card" style={{ marginTop: 12 }}>
        <strong>Satisfaction survey</strong>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Sent to the customer when a conversation is archived — they reply
          with a 1–5 rating, scored in Reports. Overrides the workspace
          survey for this agent (currently {wsOn ? 'on' : 'off'}); blank
          fields inherit the workspace text shown as placeholders.
        </div>
        <ReadOnly off={!isAdmin}>
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
            placeholder={wsPrompt}
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
            placeholder={wsThanks}
            onChange={(v) =>
              setCfg({ ...cfg, csat: { ...(cfg.csat ?? {}), thanks: v || undefined } })
            }
          />
        </div>
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
  onUpdateRule,
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
  onUpdateRule: (id: string, config: Record<string, unknown>) => void;
  onDeleteRule: (id: string) => void;
}) {
  const [kind, setKind] = useState<RuleKind>('handoff_request');
  const [editing, setEditing] = useState<AlertRule | null>(null);
  // The builder stays collapsed behind "Create rule" — an always-open form
  // reads like a rule that already exists.
  const [builderOpen, setBuilderOpen] = useState(false);
  const [keywords, setKeywords] = useState('');
  const [intents, setIntents] = useState<string[]>([]);
  const [topicDraft, setTopicDraft] = useState('');
  const [minutes, setMinutes] = useState('15');
  const [maxScore, setMaxScore] = useState('3');
  const [route, setRoute] = useState<'none' | 'route'>('none');
  const [ruleTag, setRuleTag] = useState('');
  const [pool, setPool] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  // Who the alert PINGS — decoupled from who owns the thread. 'assignee'
  // pings the picked assignee; 'pool' everyone in the rotation; 'workspace'
  // everybody. Only meaningful on routed rules — just-alert always pings
  // the workspace.
  const [notifyMode, setNotifyMode] = useState<'assignee' | 'pool' | 'workspace'>('assignee');
  const { data: members } = useAgentMembers(agent.id);
  const { data: groupsData } = useGroups();
  const { data: users } = useUsers();
  const { data: wsRow } = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      api<{ workspace: { handoff_enabled?: boolean | null } }>('/api/workspace'),
  });
  // Unset (null) reads as on — only an explicit workspace false disables.
  const wsHandoff = wsRow?.workspace.handoff_enabled !== false;
  // Routable groups: workspace rosters plus this agent's own — another
  // agent's scoped roster can't be pulled in.
  const groups = (groupsData?.groups ?? []).filter(
    (g) => !g.agent_id || g.agent_id === agent.id,
  );
  // Assignable teammates = every active workspace member plus agent-scoped
  // users granted on this agent (agent_members rows alone miss the workspace
  // roster, which is why the picker rendered empty).
  const teammates = [
    ...(users?.users ?? [])
      .filter((u) => u.status === 'active')
      .map((u) => ({ user_id: u.id, name: u.name })),
    ...(members?.members ?? [])
      .filter((m) => m.status === 'active' && !users?.users.some((u) => u.id === m.user_id))
      .map((m) => ({ user_id: m.user_id, name: m.name })),
  ];
  const teammateName = (id: string) =>
    members?.members.find((m) => m.user_id === id)?.name ??
    users?.users.find((u) => u.id === id)?.name ??
    'a teammate';
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? 'a group';
  const topicLabels = cfg.intents?.length ? cfg.intents : [...DEFAULT_INTENTS];

  const describeRule = (r: AlertRule) => {
    const c = r.config;
    const when =
      r.kind === 'auto_assign'
        ? 'every new conversation'
        : r.kind === 'keyword'
          ? `message contains ${(c.keywords ?? []).map((k) => `"${k}"`).join(' or ')}`
          : r.kind === 'intent'
            ? `topic is ${(c.intents ?? []).join(' or ')}`
            : r.kind === 'inactivity'
              ? `no agent reply for ${c.inactivity_minutes ?? 15}m`
              : r.kind === 'csat'
                ? `CSAT score ≤ ${c.max_score ?? 3}`
                : (kindMeta(r.kind)?.hint ?? r.kind);
    const roster = [
      ...(c.assignees ?? []).map(teammateName),
      ...(c.group_ids ?? []).map((g) => `${groupName(g)} (group)`),
    ];
    const then = [
      c.assign_to ? `assign ${teammateName(c.assign_to)}` : null,
      roster.length ? `rotate ${roster.join(', ')}` : null,
      c.tag ? `tag "${c.tag}"` : null,
      c.notify === 'workspace'
        ? 'ping the whole workspace'
        : c.notify === 'pool'
          ? 'ping everyone in the rotation'
          : Array.isArray(c.notify)
            ? `ping ${(c.notify as string[]).map(teammateName).join(', ')}`
            : null,
      // Unrouted alerts ping the whole workspace — surface the default so
      // a bare rule doesn't read like it notifies nobody.
      roster.length || c.assign_to ? null : 'ping the whole workspace',
    ].filter(Boolean);
    return `${when}${then.length ? ` → ${then.join(' + ')}` : ''}`;
  };

  const toggleRule = (r: AlertRule) =>
    onUpdateRule(r.id, { ...r.config, enabled: r.config.enabled === false });

  const toggle = (list: string[], id: string, set: (v: string[]) => void) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  // A filterless kind that already has a rule can't be picked — keep Add
  // disabled too in case the select is sitting on a disabled option.
  const kindTaken =
    !editing && SINGLE_RULE_KINDS.has(kind) && rules.some((r) => r.kind === kind);
  const canAdd =
    !kindTaken &&
    (kind !== 'keyword' || keywords.trim().length > 0) &&
    (kind !== 'intent' || intents.length > 0) &&
    (route !== 'route' || pool.length + groupIds.length > 0);
  const openBuilder = () => {
    // Default the trigger to the first kind that can still take a rule.
    setKind(
      RULE_KINDS.find(
        (k) => !(SINGLE_RULE_KINDS.has(k.key) && rules.some((r) => r.kind === k.key)),
      )?.key ?? 'handoff_request',
    );
    setBuilderOpen(true);
  };

  // Editing an existing rule: "Save changes" grays out while the form still
  // holds the stored values — mirrors the unpacking in editRule. String
  // compares on the loaded field values: a retype that would produce the
  // same config may read dirty (harmless), never the reverse.
  const ruleUnchanged = useMemo(() => {
    if (!editing) return false;
    const c = editing.config;
    const sameList = (a: string[], b: string[] | undefined) =>
      a.length === (b?.length ?? 0) && a.every((x, i) => x === b?.[i]);
    return (
      sameList(
        keywords.split(',').map((k) => k.trim()).filter(Boolean),
        c.keywords,
      ) &&
      sameList(intents, c.intents) &&
      minutes === String(c.inactivity_minutes ?? 15) &&
      maxScore === String(c.max_score ?? 3) &&
      route ===
        (c.assign_to || (c.assignees ?? []).length || (c.group_ids ?? []).length
          ? 'route'
          : 'none') &&
      sameList(pool, c.assignees) &&
      sameList(groupIds, c.group_ids) &&
      ruleTag.trim() === (c.tag ?? '') &&
      (c.assign_to ?? '') ===
        (route === 'route' && pool.length === 1 && groupIds.length === 0 ? pool[0] : '') &&
      // Legacy member-list notify is API-only — the builder can only
      // reproduce the literal modes or unset, so anything else reads as
      // changed.
      notifyMode ===
        (c.notify === 'pool' ? 'pool' : c.notify === 'workspace' ? 'workspace' : c.notify === undefined ? 'assignee' : 'other')
    );
  }, [editing, keywords, intents, minutes, maxScore, route, ruleTag, pool, groupIds, notifyMode]);

  const buildConfig = (enabled: boolean) => ({
    enabled,
    ...(kind === 'keyword'
      ? { keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean) }
      : {}),
    ...(kind === 'intent' ? { intents } : {}),
    ...(kind === 'inactivity' ? { inactivity_minutes: Number(minutes) || 15 } : {}),
    ...(kind === 'csat' ? { max_score: Number(maxScore) } : {}),
    ...(route === 'route'
      ? pool.length === 1 && groupIds.length === 0
        ? { assign_to: pool[0] }
        : { assignees: pool, group_ids: groupIds, next: editing ? ((editing.config as { next?: number }).next ?? 0) : 0 }
      : {}),
    ...(ruleTag.trim() ? { tag: ruleTag.trim() } : {}),
    ...(route === 'route' && notifyMode !== 'assignee' ? { notify: notifyMode } : {}),
  });

  const resetBuilder = () => {
    setEditing(null);
    setBuilderOpen(false);
    setKeywords('');
    setIntents([]);
    setTopicDraft('');
    setRoute('none');
    setRuleTag('');
    setPool([]);
    setGroupIds([]);
    setNotifyMode('assignee');
  };

  const submitRule = () => {
    if (editing) {
      // PATCH only takes config — kind stays whatever the rule already is.
      onUpdateRule(editing.id, buildConfig(editing.config.enabled !== false));
    } else {
      onAddRule(kind, buildConfig(true));
    }
    resetBuilder();
  };

  const editRule = (r: AlertRule) => {
    const c = r.config;
    setEditing(r);
    setBuilderOpen(true);
    setKind(r.kind);
    setKeywords((c.keywords ?? []).join(', '));
    setIntents(c.intents ?? []);
    setMinutes(String(c.inactivity_minutes ?? 15));
    setMaxScore(String(c.max_score ?? 3));
    setRoute(c.assign_to || (c.assignees ?? []).length || (c.group_ids ?? []).length ? 'route' : 'none');
    setRuleTag(c.tag ?? '');
    setPool([...(c.assignees ?? []), ...(c.assign_to ? [c.assign_to] : [])]);
    setGroupIds(c.group_ids ?? []);
    setNotifyMode(c.notify === 'pool' ? 'pool' : c.notify === 'workspace' ? 'workspace' : 'assignee');
  };

  // A custom topic typed into a rule only fires if the classifier can emit
  // it — adding it joins the agent's label list alongside the rule pick.
  const addCustomTopic = () => {
    const label = topicDraft.trim().toLowerCase();
    if (!label || intents.includes(label)) return;
    setIntents([...intents, label]);
    const base = cfg.intents?.length ? cfg.intents : [...DEFAULT_INTENTS];
    if (!base.some((l) => l.toLowerCase() === label))
      setCfg({ ...cfg, intents: [...base, label] });
    setTopicDraft('');
  };

  return (
    <>
    <ReadOnly off={!isAdmin}>
      <SlackAlerts agent={agent} isAdmin={isAdmin} />
    </ReadOnly>

      <div className="card" style={{ marginTop: 12 }}>
        <strong>Alert &amp; routing rules</strong>
        <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
          When a trigger fires, Janis opens an alert and pings the whole workspace — nobody is
          assigned. Assigning a teammate or rotation makes them the thread owner (only when
          unassigned — it never steals) and pings them; Ping widens who else hears about it.
        </div>
        {rules.map((r) => (
          <div key={r.id} className="row" style={{ marginTop: 8 }}>
            <label className="check-label" title={r.config.enabled === false ? 'disabled' : 'enabled'}>
              <input
                type="checkbox"
                checked={r.config.enabled !== false}
                disabled={!isAdmin}
                onChange={() => toggleRule(r)}
              />
            </label>
            <span className={`grow${r.config.enabled === false ? ' muted' : ''}`}>
              <strong>{kindMeta(r.kind)?.label ?? r.kind}</strong>
              <span className="muted"> — {describeRule(r)}</span>
            </span>
            {isAdmin && (
              <>
                <button className="btn" onClick={() => editRule(r)} aria-label="Edit rule"><Pencil size={14} /></button>
                <button className="btn danger" onClick={() => onDeleteRule(r.id)} aria-label="Delete rule"><Trash2 size={14} /></button>
              </>
            )}
          </div>
        ))}
        {rules.length === 0 && (
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            No rules yet — handoffs, failures, and custom alerts still ping the workspace by
            default.
          </div>
        )}
        {!isAdmin && (
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            Rules are managed by workspace admins.
          </div>
        )}

        {isAdmin && !builderOpen && (
          <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 10 }}>
            <button className="btn" onClick={openBuilder}>Create rule</button>
          </div>
        )}
        {isAdmin && builderOpen && (
        <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 10 }}>
          {editing && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Editing rule — <a href="#" onClick={(e) => { e.preventDefault(); resetBuilder(); }}>cancel</a>
            </div>
          )}
          <div className="row">
            <label className="muted" style={{ fontSize: 12 }}>When</label>
            <select
              value={kind}
              disabled={!!editing}
              onChange={(e) => setKind(e.target.value as RuleKind)}
            >
              {RULE_KINDS.map((k) => {
                // Filterless kinds fire once per trigger — a second copy
                // would sit dead. Gray the option out instead of letting a
                // do-nothing rule get created.
                const taken =
                  !editing && SINGLE_RULE_KINDS.has(k.key) && rules.some((r) => r.kind === k.key);
                return (
                  <option key={k.key} value={k.key} disabled={taken}>
                    {k.label}{taken ? ' — already has a rule' : ''}
                  </option>
                );
              })}
            </select>
            <span className="muted" style={{ fontSize: 12 }}>
              {editing
                ? 'kind is fixed once created'
                : `${kindMeta(kind)?.hint ?? ''}${
                    kindMeta(kind)?.defaultOn
                      ? ' — already pings the workspace by default; a rule assigns or mutes it'
                      : ''
                  }`}
            </span>
          </div>

          {kind === 'keyword' && (
            <div className="row" style={{ marginTop: 8 }}>
              <input
                className="grow"
                placeholder="keywords, comma separated — e.g. refund, cancel, lawyer"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
              />
            </div>
          )}
          {kind === 'intent' && (
            <>
            <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              {topicLabels.map((label) => (
                <label key={label} className="check-label" style={{ marginRight: 10 }}>
                  <input
                    type="checkbox"
                    checked={intents.includes(label)}
                    onChange={() => toggle(intents, label, setIntents)}
                  />
                  {label}
                </label>
              ))}
              {intents.filter((i) => !topicLabels.some((l) => l.toLowerCase() === i.toLowerCase())).map((label) => (
                <label key={label} className="check-label" style={{ marginRight: 10 }}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => toggle(intents, label, setIntents)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <input
                style={{ width: 200 }}
                placeholder="+ custom topic"
                value={topicDraft}
                onChange={(e) => setTopicDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomTopic(); } }}
              />
              <button className="btn" disabled={!topicDraft.trim()} onClick={addCustomTopic}>Add</button>
            </div>
            </>
          )}
          {kind === 'inactivity' && (
            <div className="row" style={{ marginTop: 8 }}>
              <input
                type="number"
                min={1}
                className="num-input"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
              <span className="muted" style={{ fontSize: 12 }}>minutes without an agent reply</span>
            </div>
          )}
          {kind === 'csat' && (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>alert when a rating is</span>
              <select value={maxScore} onChange={(e) => setMaxScore(e.target.value)}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>≤ {n}</option>
                ))}
              </select>
            </div>
          )}

          <div className="row" style={{ marginTop: 8 }}>
            <label className="muted" style={{ fontSize: 12 }}>Then</label>
            <select
              value={route}
              onChange={(e) => {
                const v = e.target.value as typeof route;
                setRoute(v);
                // ping choice is meaningless with nobody assigned — reset.
                if (v !== 'route') setNotifyMode('assignee');
              }}
            >
              <option value="none">just alert</option>
              <option value="route">assign to teammates…</option>
            </select>
            <input
              style={{ width: 130 }}
              placeholder="+ tag (optional)"
              value={ruleTag}
              onChange={(e) => setRuleTag(e.target.value)}
            />
          </div>
          {route !== 'route' && (
            <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
              Pings the whole workspace — nobody is assigned.
            </div>
          )}
          {route === 'route' && (
            <>
            <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              {teammates.map((m) => (
                <label key={m.user_id} className="check-label" style={{ marginRight: 10 }}>
                  <input
                    type="checkbox"
                    checked={pool.includes(m.user_id)}
                    onChange={() => toggle(pool, m.user_id, setPool)}
                  />
                  {m.name}
                </label>
              ))}
              {groups.map((g) => (
                <label key={g.id} className="check-label" style={{ marginRight: 10 }}>
                  <input
                    type="checkbox"
                    checked={groupIds.includes(g.id)}
                    onChange={() => toggle(groupIds, g.id, setGroupIds)}
                  />
                  {g.name} <span className="muted">({g.member_ids.length})</span>
                </label>
              ))}
              {groups.length === 0 && teammates.length === 0 && (
                <span className="muted" style={{ fontSize: 12 }}>
                  No teammates or groups yet — invite people or create a group in the Team tab.
                </span>
              )}
            </div>
            <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
              One teammate becomes the fixed owner; more than one rotates between them.
              Groups join the rotation by roster.
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <label className="muted" style={{ fontSize: 12 }}>Ping</label>
              <select
                value={notifyMode}
                onChange={(e) => setNotifyMode(e.target.value as typeof notifyMode)}
              >
                <option value="assignee">whoever's assigned</option>
                <option value="pool">everyone in the rotation</option>
                <option value="workspace">the whole workspace</option>
              </select>
            </div>
            </>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" disabled={!canAdd || ruleUnchanged} onClick={submitRule}>
              {editing ? 'Save changes' : 'Add rule'}
            </button>
            <button className="btn" onClick={resetBuilder}>Cancel</button>
          </div>
          {kind === 'intent' && (
            <>
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              Topic labels — what the classifier tags conversations with:
            </div>
            <div className="row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
              {topicLabels.map((label, i) => (
                <span key={label} className="badge" style={{ marginRight: 4 }}>
                  {label}
                  <button
                    className="btn ghost"
                    style={{ padding: '0 2px', marginLeft: 2 }}
                    aria-label={`Remove ${label}`}
                    onClick={() =>
                      setCfg({ ...cfg, intents: topicLabels.filter((_, x) => x !== i) })
                    }
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
            <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
              {!cfg.intents?.length
                ? 'Using the default topics — editing makes the list explicit. '
                : ''}
              The same labels Reports → Topics tallies; label edits save with the page's Save button.
            </div>
            </>
          )}
        </div>
        )}

      </div>

    <ReadOnly off={!isAdmin}>
      <div className="card" style={{ marginTop: 12 }}>
        <strong>Human takeover</strong>
        <div className="form-field" style={{ marginTop: 8 }}>
          <label className="check-label">
            <input
              type="checkbox"
              checked={cfg.handoff_enabled !== undefined}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  handoff_enabled: e.target.checked ? true : undefined,
                })
              }
            />
            Override the workspace default (currently {wsHandoff ? 'on' : 'off'}) for this agent
          </label>
          {cfg.handoff_enabled !== undefined && (
            <select
              value={cfg.handoff_enabled ? 'on' : 'off'}
              onChange={(e) =>
                setCfg({ ...cfg, handoff_enabled: e.target.value === 'on' })
              }
            >
              <option value="on">On — can offer or escalate to a human</option>
              <option value="off">Off — resolves or says it can't; never promises a human</option>
            </select>
          )}
        </div>
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
    </ReadOnly>

    <AgentProfileOverride agent={agent} />

    <ReadOnly off={!isAdmin}>
      <AgentSavedRepliesCard agent={agent} />
    </ReadOnly>
    </>
  );
}

/** Settings → Team: per-agent membership + roster groups. Profile overrides
 *  live under Escalation (that's where a teammate's identity meets the
 *  customer conversation). */
function TeamSection({ agent, isAdmin }: { agent: Agent; isAdmin: boolean }) {
  return (
    <>
      <AgentTeamCard agent={agent} isAdmin={isAdmin} />
      <AgentGroups agent={agent} isAdmin={isAdmin} />
    </>
  );
}

/** Agent-scoped groups — rosters only this agent's routing rules can use.
 *  Eligible members: the workspace roster plus this agent's agent-only
 *  members (the same union the rule editor's teammate picker shows). */
function AgentGroups({ agent, isAdmin }: { agent: Agent; isAdmin: boolean }) {
  const { data: members } = useAgentMembers(agent.id);
  const { data: wsUsers } = useUsers();
  const wsIds = new Set((wsUsers?.users ?? []).map((u) => u.id));
  const roster = [
    ...(wsUsers?.users ?? [])
      .filter((u) => u.status === 'active')
      .map((u) => ({ id: u.id, name: u.name })),
    ...(members?.members ?? [])
      .filter((m) => m.status === 'active' && !wsIds.has(m.user_id))
      .map((m) => ({ id: m.user_id, name: m.name })),
  ];
  return <MemberGroups agentId={agent.id} roster={roster} canManage={isAdmin} />;
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
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [show, setShow] = useState<'inherit' | 'on' | 'off'>('inherit');
  const [msg, setMsg] = useState('');

  const hasOverride = Boolean(
    mine && (mine.display_name || mine.avatar_override || mine.show_identity !== null),
  );
  useEffect(() => {
    if (on !== null || !members) return;
    setOn(hasOverride);
    setName(mine?.display_name ?? '');
    setAvatar(mine?.avatar_override ?? '');
    setShow(mine?.show_identity == null ? 'inherit' : mine.show_identity ? 'on' : 'off');
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
    setAvatarUploading(true);
    setMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'include' });
      if (res.ok) setAvatar(((await res.json()) as { url: string }).url);
      else setMsg('Upload failed.');
    } finally {
      setAvatarUploading(false);
    }
  };

  const baseName = me?.user.display_name || me?.user.name.split(' ')[0] || 'your profile name';
  // Workspace-level visibility the agent-side control inherits —
  // users.show_identity, null/false = anonymous.
  const wsShown = me?.user.show_identity !== false;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <strong>Profile override</strong>
      <div className="muted" style={{ margin: '4px 0 8px' }}>
        Your name &amp; avatar as customers see them on this agent's channels.
        Off — inherits your workspace profile ({baseName},{' '}
        {wsShown ? 'shown to customers' : 'kept anonymous'}).
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
            <label
              className="btn"
              style={{ cursor: avatarUploading ? 'default' : 'pointer', opacity: avatarUploading ? 0.6 : 1 }}
            >
              {avatarUploading ? 'Uploading…' : avatar ? 'Change avatar' : 'Upload avatar'}
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={avatarUploading}
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
          <div className="row" style={{ marginTop: 8 }}>
            <span>Show my name &amp; avatar to customers</span>
            <select
              value={show}
              onChange={(e) => setShow(e.target.value as 'inherit' | 'on' | 'off')}
            >
              <option value="inherit">
                Inherit ({wsShown ? 'shown' : 'anonymous'})
              </option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Hidden — your replies stay anonymous even on enabled channels.
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn"
              disabled={
                save.isPending ||
                (name.trim() === (mine?.display_name ?? '') &&
                  avatar === (mine?.avatar_override ?? '') &&
                  (show === 'inherit' ? null : show === 'on') ===
                    (mine?.show_identity ?? null))
              }
              onClick={() =>
                save.mutate({
                  display_name: name.trim() || null,
                  avatar_url: avatar || null,
                  show_identity: show === 'inherit' ? null : show === 'on',
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

/** Event keys where a per-agent override can differ from workspace prefs —
 *  same buckets as Settings → Notifications. */
/** Per-member notification override editor — tri-state channels and events
 *  (inherit/on/off). Rendered inside a modal from the row's "alerts" button;
 *  self-service for the member's own row, admin-facing for anyone else's. */
function MemberNotifyEditor({
  agentId,
  userId,
  notify,
  onSaved,
}: {
  agentId: string;
  userId: string;
  notify: AgentMember['notify'];
  onSaved: () => void;
}) {
  // Channel prefs are tri-state like events — absent = inherit the member's
  // own workspace notify prefs. Seeding them `?? true` and always writing
  // them would stamp explicit overrides on every save.
  const [prefs, setPrefs] = useState<{ push?: boolean; email?: boolean; sound?: boolean }>({
    push: notify?.push,
    email: notify?.email,
    sound: notify?.sound,
  });
  const [events, setEvents] = useState<Record<string, boolean>>(notify?.events ?? {});
  const [msg, setMsg] = useState('');

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/agents/${agentId}/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ notify: body }),
      }),
    onSuccess: () => {
      setMsg('Saved.');
      onSaved();
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'failed'),
  });

  const eventState = (key: string) =>
    events[key] === true ? 'on' : events[key] === false ? 'off' : 'inherit';
  const setEvent = (key: string, state: 'inherit' | 'on' | 'off') => {
    const next = { ...events };
    if (state === 'inherit') delete next[key];
    else next[key] = state === 'on';
    setEvents(next);
    save.mutate({ ...prefs, events: next });
  };
  // Bulk apply — 13 dropdowns is homework; one select stamps every event.
  const bulkState = (() => {
    const vals = NOTIFY_EVENT_LABELS.map(([k]) => events[k]);
    if (vals.every((v) => v === true)) return 'on';
    if (vals.every((v) => v === false)) return 'off';
    if (vals.every((v) => v === undefined)) return 'inherit';
    return 'mixed';
  })();
  const setAllEvents = (state: 'inherit' | 'on' | 'off') => {
    const next: Record<string, boolean> = {};
    if (state !== 'inherit')
      for (const [k] of NOTIFY_EVENT_LABELS) next[k] = state === 'on';
    setEvents(next);
    save.mutate({ ...prefs, events: next });
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        Per-agent overrides — Inherit follows the member's own workspace
        notification settings (Settings → Me); unset is on.
      </div>
      <div className="row">
        {([['push', 'Web push'], ['email', 'Email'], ['sound', 'Alert sounds']] as const).map(([k, label]) => (
          <span key={k} className="row" style={{ marginRight: 12, gap: 6 }}>
            <span>{label}</span>
            <select
              value={prefs[k] === true ? 'on' : prefs[k] === false ? 'off' : 'inherit'}
              onChange={(e) => {
                const next = { ...prefs };
                const v = e.target.value;
                if (v === 'inherit') delete next[k];
                else next[k] = v === 'on';
                setPrefs(next);
                save.mutate({ ...next, events });
              }}
              disabled={save.isPending}
            >
              <option value="inherit">Inherit</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </span>
        ))}
        {msg && <span className="muted">{msg}</span>}
      </div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>Event types</span>
        <select
          value={bulkState}
          onChange={(e) => setAllEvents(e.target.value as 'inherit' | 'on' | 'off')}
          disabled={save.isPending}
        >
          {bulkState === 'mixed' && <option value="mixed" disabled>mixed — set all:</option>}
          <option value="inherit">All inherit</option>
          <option value="on">All on</option>
          <option value="off">All off</option>
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '4px 12px', fontSize: 13, marginTop: 6 }}>
        {NOTIFY_EVENT_LABELS.map(([key, label]) => (
          <div key={key} className="row" style={{ justifyContent: 'space-between' }}>
            <span>{label}</span>
            <select
              value={eventState(key)}
              onChange={(e) => setEvent(key, e.target.value as 'inherit' | 'on' | 'off')}
              disabled={save.isPending}
            >
              <option value="inherit">Inherit</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </div>
        ))}
      </div>
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
  const [form, setForm] = useState<{
    email: string;
    name: string;
    role: string;
    scope: 'agent' | 'workspace';
  }>({ email: '', name: '', role: 'member', scope: 'agent' });
  const [err, setErr] = useState('');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['agentMembers', agent.id] });
    void qc.invalidateQueries({ queryKey: ['users'] });
  };
  // One add row, two scopes — 'agent' grants just this inbox (auto-accepted
  // on sign-in); 'workspace' sends the same invite Settings → Team sends.
  const add = useMutation({
    mutationFn: (b: typeof form) =>
      b.scope === 'agent'
        ? api(`/api/agents/${agent.id}/members`, {
            method: 'POST',
            body: JSON.stringify({
              email: b.email,
              ...(b.name ? { name: b.name } : {}),
              role: b.role,
            }),
          })
        : api('/api/users', {
            method: 'POST',
            body: JSON.stringify({
              email: b.email,
              ...(b.name ? { name: b.name } : {}),
              role: b.role,
            }),
          }),
    onSuccess: () => {
      setForm({ email: '', name: '', role: 'member', scope: 'agent' });
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
  // Your own row first, everyone else alphabetical.
  const selfId = me?.user.id;
  const selfFirst = <T,>(rows: T[], id: (r: T) => string, name: (r: T) => string) =>
    [...rows].sort(
      (a, b) =>
        Number(id(b) === selfId) - Number(id(a) === selfId) ||
        name(a).localeCompare(name(b)),
    );

  // Workspace members render as ONE list — plain members and members with
  // an override row merged — so self-first actually floats you to the top
  // regardless of which shape your row has.
  const wsRows = selfFirst(
    [
      ...plainMembers.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        memberRole: null as string | null,
        notify: null as AgentMember['notify'],
        wsRole: u.role,
      })),
      ...memberRows
        .filter((m) => wsById.has(m.user_id))
        .map((m) => ({
          id: m.user_id,
          name: m.name,
          email: m.email,
          memberRole: m.role,
          notify: m.notify,
          wsRole: wsById.get(m.user_id)?.role ?? 'member',
        })),
    ],
    (r) => r.id,
    (r) => r.name,
  );
  const ownerId = agent.owner_user_id;
  const isOwner = me?.user.id === ownerId;

  const roleBadge = (v: string) =>
    v === 'hidden' ? 'no privileges (hidden)' : v;

  const [notifyFor, setNotifyFor] = useState<string | null>(null);
  // One editor per person: admins manage anyone's overrides; a member gets
  // the button only on their own row (the API allows self-service PATCHes).
  const notifyToggle = (userId: string) =>
    isAdmin || userId === me?.user.id ? (
      <button
        className="btn ghost"
        onClick={() => setNotifyFor(notifyFor === userId ? null : userId)}
        title="Alert overrides for this agent"
        aria-label="Alert overrides"
      >
        <Pencil size={14} />
      </button>
    ) : null;
  const notifyEditor = (userId: string, notify: AgentMember['notify'], name: string) =>
    notifyFor === userId ? (
      <div className="modal-backdrop" onClick={() => setNotifyFor(null)}>
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          style={{ width: 680 }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setNotifyFor(null);
          }}
        >
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>Alert overrides — {name}</strong>
            <button
              className="btn ghost"
              onClick={() => setNotifyFor(null)}
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
          <MemberNotifyEditor
            agentId={agent.id}
            userId={userId}
            notify={notify}
            onSaved={refresh}
          />
        </div>
      </div>
    ) : null;

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
      <ul className="muted" style={{ margin: '6px 0 4px', paddingLeft: 18, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <li><strong>admin</strong> — manages this agent's settings, team &amp; rules</li>
        <li><strong>member</strong> — works the inbox: reply, take over, assign</li>
        <li><strong>no privileges</strong> — hides the agent from a workspace member entirely</li>
        <li><strong>owner</strong> — fixed; transferable only by the owner</li>
      </ul>
      <TeamTable>
        {wsRows.map((r) => (
          <TeamRow key={r.id}>
            <MemberCell name={r.name} email={r.email} isYou={r.id === selfId}>
              {/* A member row can exist with no role — saved profile or
                  notify prefs alone shouldn't badge it as overridden.
                  Nor should the owner — their stored role is vestigial,
                  owner_user_id wins regardless. */}
              {r.memberRole && r.id !== ownerId && (
                <span className="badge" style={{ marginLeft: 8 }}>override</span>
              )}
            </MemberCell>
            <td style={teamTd}>
              {notifyToggle(r.id)}
              {notifyEditor(r.id, r.notify, r.name)}
            </td>
            <td style={teamTd}>{roleSelect(r.id, r.memberRole ?? 'inherit', r.wsRole, true)}</td>
            <td style={teamTd} />
          </TeamRow>
        ))}
        {selfFirst(agentOnly, (m) => m.user_id, (m) => m.name).map((m) => (
          <TeamRow key={m.user_id}>
            <MemberCell name={m.name} email={m.email} isYou={m.user_id === selfId}>
              <span className="badge" style={{ marginLeft: 8 }}>this agent only</span>
            </MemberCell>
            <td style={teamTd}>
              {notifyToggle(m.user_id)}
              {notifyEditor(m.user_id, m.notify, m.name)}
            </td>
            <td style={teamTd}>{roleSelect(m.user_id, m.role ?? 'member', null, false)}</td>
            <td style={teamTd}>
              {isAdmin && m.user_id !== ownerId && (
                <button
                  className="btn ghost"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => remove.mutate(m.user_id)}
                  title="Remove access"
                  aria-label="Remove access"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </td>
          </TeamRow>
        ))}
      </TeamTable>
      {isAdmin && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 18, paddingTop: 14 }}>
        <strong style={{ fontSize: 13 }}>Invite teammate</strong>
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
          <input
            placeholder="name (optional)"
            style={{ width: 140 }}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <select
            value={form.scope}
            onChange={(e) => {
              const scope = e.target.value as 'agent' | 'workspace';
              setForm({
                ...form,
                scope,
                role: scope === 'agent' && form.role === 'viewer' ? 'member' : form.role,
              });
            }}
          >
            <option value="agent">this agent only</option>
            <option value="workspace">whole workspace</option>
          </select>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="member">member</option>
            <option value="admin">admin</option>
            {form.scope === 'workspace' && <option value="viewer">viewer (read-only)</option>}
          </select>
          <button className="btn" disabled={add.isPending}>Invite</button>
        </form>
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          "This agent only" — just this inbox; they sign in with Google or
          Slack, no workspace invite needed. "Whole workspace" — the same
          invite as Settings → Team; a teammate who sees every agent.
        </div>
        {err && <div className="error">{err}</div>}
        </div>
      )}
    </div>
  );
}

export function ToolsTab({
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
      <IntegrationCards cfg={cfg} setCfg={setCfg} agentId={agentId} />
      <details
        key={customTools.length ? 'adv-open' : 'adv'}
        open={customTools.length > 0}
        style={{ marginTop: 12 }}
      >
        <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>
          Advanced — custom API actions and secrets
        </summary>
        <div style={{ marginTop: 10 }}>
          <div className="card" style={{ padding: 14, margin: '0 0 10px', maxWidth: 320 }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <strong>Custom API action</strong>
              <span className="badge" style={{ marginLeft: 'auto' }}>JSON</span>
            </div>
            <div className="muted" style={{ fontSize: 12, margin: '8px 0 10px' }}>
              Call any API — describe the request as JSON. "approval": true gates it behind
              teammate sign-off.
            </div>
            <button className="btn" onClick={() => setShowCustom((v) => !v)}>
              {showCustom ? 'Hide editor' : 'Configure'}
            </button>
          </div>
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
        </div>
      </details>
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
}: {
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  agentId: string;
}) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['tool-templates'],
    queryFn: () => api<{ templates: ToolTemplateInfo[] }>('/api/tool-templates'),
    staleTime: 300_000,
  });
  const gconn = useQuery({
    queryKey: ['google-conn', agentId],
    queryFn: () =>
      api<{ connected: boolean; label: string | null }>(
        `/api/google/connection?agent_id=${agentId}`,
      ),
  });
  const gfiles = useQuery({
    queryKey: ['google-files', agentId],
    queryFn: () =>
      api<{ files: { id: string; name: string; mimeType: string; webViewLink?: string }[] }>(
        `/api/google/files?agent_id=${agentId}`,
      ),
    enabled: gconn.data?.connected === true,
  });
  // Platform tools — in-process builtins on Janis infrastructure (web
  // search today). No credentials; toggles write config.builtin_tools.
  const { data: builtin } = useQuery({
    queryKey: ['builtin-tools', agentId],
    queryFn: () =>
      api<{ plan: string; tools: { name: string; description: string; enabled: boolean }[] }>(
        `/api/agents/${agentId}/builtin-tools`,
      ),
  });
  const [builtinErr, setBuiltinErr] = useState('');
  const toggleBuiltin = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      api<{ agent: Agent }>(`/api/agents/${agentId}/builtin-tools`, {
        method: 'PATCH',
        body: JSON.stringify({ name, enabled }),
      }),
    onSuccess: (r) => {
      setCfg({ ...cfg, builtin_tools: r.agent.config?.builtin_tools });
      setBuiltinErr('');
      void qc.invalidateQueries({ queryKey: ['builtin-tools', agentId] });
      void qc.invalidateQueries({ queryKey: ['build-status', agentId] });
    },
    onError: (e) => setBuiltinErr(e.message),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  // OAuth returns land back on this tab with a flash param — surface it and
  // clear the query so a refresh doesn't replay the banner.
  const [params, setParams] = useSearchParams();

  const openGooglePicker = async (tplId: string) => {
    const boot = await api<{ access_token: string; developer_key: string; app_id: string }>(
      `/api/google/picker-token?agent_id=${agentId}`,
    );
    const w = window as any;
    const open = () => {
      const MIME: Record<string, string> = {
        'google-sheets': 'application/vnd.google-apps.spreadsheet',
        'google-docs': 'application/vnd.google-apps.document',
        'google-slides': 'application/vnd.google-apps.presentation',
      };
      const view = MIME[tplId]
        ? new w.google.picker.DocsView().setMimeTypes(MIME[tplId])
        : new w.google.picker.DocsView()
            .setIncludeFolders(true)
            .setSelectFolderEnabled(true);
      const picker = new w.google.picker.PickerBuilder()
        .setOAuthToken(boot.access_token)
        .setDeveloperKey(boot.developer_key)
        .setAppId(boot.app_id)
        .addView(view)
        .setCallback((data: { action: string; docs?: { name: string }[] }) => {
          if (data.action === 'picked') {
            setErr(`Picked ${data.docs?.length ?? 0} item(s) — the agent can now see them.`);
            gfiles.refetch();
          }
        })
        .build();
      picker.setVisible(true);
    };
    if (!w.google?.picker) {
      const ensure = () => w.gapi.load('picker', open);
      if (w.gapi) ensure();
      else {
        const sc = document.createElement('script');
        sc.src = 'https://apis.google.com/js/api.js';
        sc.onload = ensure;
        document.head.appendChild(sc);
      }
    } else open();
  };

  const GFILE_MIME: Record<string, [string, string]> = {
    'google-sheets': ['application/vnd.google-apps.spreadsheet', 'spreadsheet'],
    'google-docs': ['application/vnd.google-apps.document', 'doc'],
    'google-slides': ['application/vnd.google-apps.presentation', 'presentation'],
    'google-drive': ['application/vnd.google-apps.document', 'doc'],
  };
  const createGoogleFile = async (tplId: string) => {
    const [mime, kind] = GFILE_MIME[tplId] ?? GFILE_MIME['google-docs'];
    const title = window.prompt(`Title for the new ${kind}`);
    if (!title?.trim()) return;
    try {
      await api(`/api/google/create-file`, {
        method: 'POST',
        body: JSON.stringify({ agent_id: agentId, mime_type: mime, title: title.trim() }),
      });
      gfiles.refetch();
      setErr(`Created "${title.trim()}" — the agent can now see it.`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // google_* files visible under a card — filtered to the card's file type.
  const gfilesFor = (tplId: string) => {
    const mime = GFILE_MIME[tplId]?.[0];
    const all = gfiles.data?.files ?? [];
    return tplId === 'google-drive' ? all : all.filter((f) => f.mimeType === mime);
  };

  const connectProvider = ['calendly', 'google'].find((p) => params.get(`${p}_connect`) != null || params.get(`${p}_error`) != null);
  const flash = connectProvider
    ? params.get(`${connectProvider}_connect`) != null
      ? { kind: 'ok' as const, msg: `${connectProvider === 'google' ? 'Google' : 'Calendly'} connected — ${params.get(`${connectProvider}_connect`)}` }
      : { kind: 'err' as const, msg: `${connectProvider === 'google' ? 'Google' : 'Calendly'} connect failed — ${params.get(`${connectProvider}_error`)}` }
    : null;
  const clearFlash = () => {
    if (!flash) return;
    for (const p of ['calendly', 'google']) {
      params.delete(`${p}_connect`);
      params.delete(`${p}_error`);
    }
    setParams(params, { replace: true });
  };
  // Back from Google consent — prompt a file pick for the card that connected.
  useEffect(() => {
    const tpl = params.get('google_tpl');
    if (!tpl) return;
    params.delete('google_tpl');
    setParams(params, { replace: true });
    void openGooglePicker(tpl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('google_tpl')]);

  const syncTools = (tools: AgentConfig['tools']) => setCfg({ ...cfg, tools });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['agents'] });
    void qc.invalidateQueries({ queryKey: ['secrets', agentId] });
    // Installs/removals change the Abilities mark — "suggested — none
    // connected" can't linger after a tool lands.
    void qc.invalidateQueries({ queryKey: ['build-status', agentId] });
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

  const setToolFlags = useMutation({
    mutationFn: ({ t, ...patch }: {
      t: ToolTemplateInfo;
      approvals?: Record<string, boolean>;
      disabled?: Record<string, boolean>;
    }) =>
      api<{ agent: Agent }>(`/api/agents/${agentId}/tools/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (r) => {
      syncTools(r.agent.config?.tools);
      invalidate();
    },
    onError: (e) => setErr(e.message),
  });

  const installedCount = (t: ToolTemplateInfo) => {
    const names = new Set((cfg.tools ?? []).map((x) => x.name));
    return t.tools.filter((x) => names.has(x.name)).length;
  };
  const installed = (t: ToolTemplateInfo) => installedCount(t) === t.tools.length;
  // Drifted installs — the template gained actions after connect, or a
  // deliberate subset was kept. Counts as connected, flagged as partial,
  // and "Update credentials"/re-install completes the set (install merges
  // by name, it never duplicates).
  const partial = (t: ToolTemplateInfo) => {
    const n = installedCount(t);
    return n > 0 && n < t.tools.length;
  };

  // Brief-derived suggestions (stored on config.builder) float their
  // templates to the top of the grid and explain why this agent needs them.
  const suggestions = cfg.builder?.suggested_templates ?? [];
  const sugOrder = new Map(suggestions.map((s, i) => [s.id, i]));
  const sugReason = new Map(suggestions.map((s) => [s.id, s.reason]));
  const templates = [...(data?.templates ?? [])].sort(
    (a, b) =>
      (sugOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (sugOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );

  // Progressive disclosure — suggested-for-this-agent (plus anything
  // already installed) leads; the rest of the catalog is one click away
  // under "Browse all", not a wall of irrelevant cards.
  const shown = templates.filter((t) => sugOrder.has(t.id) || installedCount(t) > 0);
  const rest = templates.filter((t) => !shown.includes(t));
  const grid = (list: ToolTemplateInfo[]) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
      {list.map(card)}
    </div>
  );

  function card(t: ToolTemplateInfo) {
    return (
        <div
          key={t.id}
          className="card"
          style={{
            padding: 14, margin: 0,
            ...(sugOrder.has(t.id) ? { borderColor: 'var(--accent-dim)' } : null),
          }}
        >
          <div className="row" style={{ alignItems: 'center' }}>
            <strong>{t.name}</strong>
            {sugOrder.has(t.id) && <span className="badge human">suggested</span>}
            {t.auth === 'oauth' && <span className="badge">oauth</span>}
            <span className="badge" style={{ marginLeft: 'auto' }}>{t.category}</span>
          </div>
          <div className="muted" style={{ fontSize: 12, margin: '8px 0 10px' }}>{t.blurb}</div>
          {sugReason.get(t.id) ? (
            <div className="muted" style={{ fontSize: 11, margin: '-4px 0 10px', fontStyle: 'italic' }}>
              From your brief — {sugReason.get(t.id)}
            </div>
          ) : null}
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
              <div style={{ fontSize: 11, marginBottom: 2 }}>
                Tick an action to require a teammate's approval before it runs:
              </div>
              {t.tools.map((x) => {
                const live = (cfg.tools ?? []).find((o) => o.name === x.name);
                const gated = live ? !!live.approval : !!x.approval;
                const off = !!live?.disabled;
                return (
                  <div
                    key={x.name}
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        cursor: off ? 'default' : 'pointer',
                        opacity: off ? 0.5 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={gated}
                        disabled={setToolFlags.isPending || off}
                        onChange={(e) =>
                          setToolFlags.mutate({ t, approvals: { [x.name]: e.target.checked } })
                        }
                      />
                      <span>{x.label ?? x.name}</span>
                      {gated && !off && <span className="badge">needs approval</span>}
                    </label>
                    {off && <span className="badge">off</span>}
                    <button
                      className="btn sm"
                      style={{ marginLeft: 'auto', padding: '1px 8px', fontSize: 11 }}
                      disabled={setToolFlags.isPending}
                      onClick={() => setToolFlags.mutate({ t, disabled: { [x.name]: !off } })}
                    >
                      {off ? 'Enable' : 'Disable'}
                    </button>
                  </div>
                );
              })}
              <div style={{ fontSize: 11, marginTop: 4 }}>
                Unticked actions run on their own. Disabled actions aren't offered to the agent at all.
              </div>
            </div>
          ) : null}
          {t.oauth_connect === '/api/google/connect' && installed(t) && (
            <div className="muted" style={{ fontSize: 11, margin: '0 0 10px' }}>
              {gfilesFor(t.id).length === 0 ? (
                <>No files shared yet — pick or create one above.</>
              ) : (
                gfilesFor(t.id).map((f) => (
                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <a href={f.webViewLink} target="_blank" rel="noreferrer">
                      {f.name}
                    </a>
                    <button
                      className="btn sm"
                      style={{ marginLeft: 'auto', padding: '0 6px', fontSize: 11 }}
                      title="Unshare this file"
                      onClick={async () => {
                        await api(`/api/google/unfile`, {
                          method: 'POST',
                          body: JSON.stringify({ agent_id: agentId, file_id: f.id }),
                        });
                        gfiles.refetch();
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
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
                  disabled={install.isPending || t.fields.some((f) => !f.optional && !fields[f.key]?.trim())}
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
              {/* Janis-owned OAuth apps get a consent link, not a form — the
                  callback stores the connection and installs the tools. */}
              {t.oauth_connect && !installed(t) ? (
                t.oauth_connect === '/api/google/connect' && gconn.data?.connected ? (
                  <button className="btn" onClick={() => install.mutate(t)}>
                    Add
                  </button>
                ) : (
                  <a
                    className="btn primary"
                    href={`${t.oauth_connect}?agent_id=${agentId}${t.oauth_connect === '/api/google/connect' ? `&tpl=${t.id}` : ''}`}
                    onClick={clearFlash}
                  >
                    Connect {t.name.replace(/ \(OAuth\)$/, '')}
                  </a>
                )
              ) : null}
              {/* Credential-less integrations have nothing to update once
                  installed — show the badge + Remove, not a dead button. */}
              {t.oauth_connect === '/api/google/connect' && installed(t) && (
                <>
                  <button className="btn" onClick={() => openGooglePicker(t.id)}>
                    Pick files…
                  </button>
                  <button className="btn" onClick={() => createGoogleFile(t.id)}>
                    Create new…
                  </button>
                </>
              )}
              {!t.oauth_connect && (!installed(t) || t.fields.length > 0) && (
                <button
                  className="btn"
                  onClick={() =>
                    t.fields.length ? (setOpenId(t.id), setErr(''), setFields({})) : install.mutate(t)
                  }
                >
                  {partial(t)
                    ? 'Complete setup'
                    : installed(t)
                      ? 'Update credentials'
                      : t.fields.length
                        ? 'Connect'
                        : 'Add'}
                </button>
              )}
              {installedCount(t) > 0 && (
                <>
                  {/* 'connected' overstates a credential-less add — 'enabled' */}
                  <span className={`badge${installed(t) ? ' active' : ''}`}>
                    {partial(t)
                      ? `partial — ${installedCount(t)}/${t.tools.length} actions`
                      : t.fields.length || t.oauth_connect
                        ? 'connected'
                        : 'enabled'}
                  </span>
                  <button className="btn" onClick={() => remove.mutate(t)}>Remove</button>
                </>
              )}
            </div>
          )}
        </div>
    );
  }

  return (
    <>
      {flash && (
        <div
          className={flash.kind === 'ok' ? 'badge active' : 'error'}
          style={{ display: 'inline-block', marginBottom: 10 }}
        >
          {flash.msg}
        </div>
      )}
      {builtin?.tools.length ? (
        <div className="card" style={{ padding: 14, marginBottom: 14 }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <strong>Platform tools</strong>
            <span className="badge">included</span>
            {builtin.plan === 'free' && <span className="badge human">paid plan</span>}
          </div>
          {builtin.tools.map((t) => (
            <div key={t.name} style={{ marginTop: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={t.enabled}
                  disabled={toggleBuiltin.isPending}
                  onChange={(e) => toggleBuiltin.mutate({ name: t.name, enabled: e.target.checked })}
                />
                <span>{t.name.replace(/_/g, ' ')}</span>
                {t.enabled && <span className="badge active">on</span>}
              </label>
              <div className="muted" style={{ fontSize: 12, margin: '2px 0 0 24px' }}>
                {t.description}
              </div>
            </div>
          ))}
          {builtin.plan === 'free' && (
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              Platform tools run on Janis infrastructure — they need a paid plan.{' '}
              <a href="/billing">Upgrade</a>
            </div>
          )}
          {builtinErr && <div className="error" style={{ marginTop: 8 }}>{builtinErr}</div>}
        </div>
      ) : null}
      {shown.length ? (
        <>
          {grid(shown)}
          {rest.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>
                Browse all integrations ({rest.length})
              </summary>
              <div style={{ marginTop: 10 }}>{grid(rest)}</div>
            </details>
          )}
        </>
      ) : (
        grid(rest)
      )}
    </>
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
  isAdmin,
  name,
  setName,
  webhookUrl,
  setWebhookUrl,
  onSaveHosted,
  onTestWebhook,
}: {
  agent: Agent;
  isAdmin: boolean;
  name: string;
  setName: (s: string) => void;
  webhookUrl: string;
  setWebhookUrl: (s: string) => void;
  onSaveHosted: (hosted: boolean) => void;
  onTestWebhook: () => void;
}) {
  return (
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <label style={{ margin: 0 }}>Name</label>
          <input
            className="grow"
            style={{ fontWeight: 600 }}
            value={name}
            disabled={!isAdmin}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
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
    );
}

/** Help center domain — per-agent override of the workspace help_domain.
 *  Set: this agent's centre alone answers on the host. Blank: inherits the
 *  workspace domain, which lists every agent with published articles. The
 *  Articles manager's Publishing-settings field writes the same key. */
function HelpDomainCard({
  cfg,
  setCfg,
  isAdmin,
}: {
  cfg: AgentConfig;
  setCfg: (c: AgentConfig) => void;
  isAdmin: boolean;
}) {
  const { data: ws } = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api<{ workspace: { help_domain: string | null } }>('/api/workspace'),
  });
  const wsDomain = ws?.workspace.help_domain ?? null;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <strong>Help center domain</strong>
      <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
        Serve this agent's help centre on its own domain —{' '}
        {wsDomain
          ? `overrides the workspace domain (${wsDomain}), which otherwise lists every agent's articles.`
          : 'a workspace-wide default can also be set under Settings → Workspace.'}{' '}
        Point the domain's CNAME at {window.location.host} first.
      </div>
      <ReadOnly off={!isAdmin}>
        <input
          className="mono"
          style={{ maxWidth: 320 }}
          placeholder={
            wsDomain ? `${wsDomain} (inherited — blank keeps it)` : 'help.yourdomain.com'
          }
          value={cfg.help_domain ?? ''}
          onChange={(e) =>
            setCfg({
              ...cfg,
              help_domain: e.target.value.trim().toLowerCase() || null,
            })
          }
          maxLength={200}
        />
      </ReadOnly>
    </div>
  );
}

/** API key / webhook secret / deliveries — its own card so the General tab
 *  can order it below the LLM override. */
type ApiKeyRow = {
  id: string;
  label: string;
  preview: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

function CredentialsCard({
  agent,
  isAdmin,
  onRotateKey,
  onRotateSecret,
  onRevealSecret,
  freshSecret,
}: {
  agent: Agent;
  isAdmin: boolean;
  onRotateKey: () => void;
  onRotateSecret: () => void;
  onRevealSecret: () => void;
  freshSecret: { label: string; value: string } | null;
}) {
  const [showDeliveries, setShowDeliveries] = useState(false);
  const [keyLabel, setKeyLabel] = useState('');
  const [createdKey, setCreatedKey] = useState<{ label: string; value: string } | null>(null);
  const { data: deliveries } = useDeliveries(showDeliveries ? agent.id : null);
  const { data: keysData, refetch: refetchKeys } = useQuery({
    queryKey: ['apiKeys', agent.id],
    queryFn: () =>
      api<{ keys: ApiKeyRow[] }>(`/api/agents/${agent.id}/api-keys`),
  });
  const createKey = useMutation({
    mutationFn: (label: string) =>
      api<{ key: { api_key: string } }>(`/api/agents/${agent.id}/api-keys`, {
        method: 'POST',
        body: JSON.stringify({ label }),
      }),
    onSuccess: (r, label) => {
      setCreatedKey({ label, value: r.key.api_key });
      setKeyLabel('');
      void refetchKeys();
    },
  });
  const revokeKey = useMutation({
    mutationFn: (keyId: string) =>
      api(`/api/agents/${agent.id}/api-keys/${keyId}/revoke`, { method: 'POST' }),
    onSettled: () => void refetchKeys(),
  });
  const revokeLegacy = useMutation({
    mutationFn: () =>
      api(`/api/agents/${agent.id}/api-keys/legacy/revoke`, { method: 'POST' }),
    onSettled: () => void qcLocal.invalidateQueries({ queryKey: ['agents'] }),
  });
  const qcLocal = useQueryClient();
  const replay = useMutation({
    mutationFn: (deliveryId: string) =>
      api(`/api/agents/${agent.id}/deliveries/${deliveryId}/replay`, { method: 'POST' }),
    onSettled: () => void qcLocal.invalidateQueries({ queryKey: ['deliveries'] }),
  });

  return (
      <div className="card" style={{ marginTop: 12 }}>
        <strong>Credentials{agent.hosted ? '' : ' &amp; deliveries'}</strong>
        {freshSecret && (
          <FreshSecretCard label={freshSecret.label} value={freshSecret.value} />
        )}
        {createdKey && (
          <FreshSecretCard label={`API key "${createdKey.label}"`} value={createdKey.value} />
        )}
        {agent.api_key_preview && (
          <div className="row" style={{ marginTop: 6 }}>
            <span className="grow">Primary · <span className="mono">{agent.api_key_preview}</span></span>
            {isAdmin && (
              <>
                <button className="btn" onClick={onRotateKey}>Rotate</button>
                <button className="btn" disabled={revokeLegacy.isPending} onClick={() => revokeLegacy.mutate()}>Revoke</button>
              </>
            )}
          </div>
        )}
        {(keysData?.keys ?? []).map((k) => (
          <div className="row" key={k.id} style={{ marginTop: 6, opacity: k.revoked_at ? 0.5 : 1 }}>
            <span className="grow">{k.label} <span className="mono muted">{k.preview}</span></span>
            <span className="muted" style={{ fontSize: 12 }}>
              {k.revoked_at
                ? `revoked ${timeAgo(k.revoked_at)}`
                : k.last_used_at
                  ? `used ${timeAgo(k.last_used_at)}`
                  : 'never used'}
            </span>
            {isAdmin && !k.revoked_at && (
              <button className="btn" disabled={revokeKey.isPending} onClick={() => revokeKey.mutate(k.id)}>
                Revoke
              </button>
            )}
          </div>
        ))}
        {isAdmin && (
          <div className="row" style={{ marginTop: 8 }}>
            <input
              className="grow"
              placeholder="New key label — e.g. Zapier, cron job"
              value={keyLabel}
              onChange={(e) => setKeyLabel(e.target.value)}
            />
            <button
              className="btn"
              disabled={!keyLabel.trim() || createKey.isPending}
              onClick={() => createKey.mutate(keyLabel.trim())}
            >
              Create API key
            </button>
          </div>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          {isAdmin && (
            <>
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
  );
}

/* ---- shared subcomponents ---- */

/** Per-agent LLM override — empty llm block inherits the workspace default
 *  (Settings → Default LLM), which itself falls back to the env default. */
export function LlmCard({
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
export function KnowledgeGaps({ agentId, config }: { agentId: string; config: AgentConfig }) {
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
  // An 'added' note's text already lives in the knowledge base — nothing
  // left to do, and no action existed anyway. Drop it from the list; it
  // resurfaces on its own if the covering entry is ever removed.
  const learnings = (data?.learnings ?? []).filter(
    (l) => !dismissedL.has(l.key) && !l.added,
  );
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
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              self-reported · last seen {timeAgo(l.last_seen)}
            </div>
            <textarea
              rows={4}
              style={{ marginTop: 8, width: '100%', boxSizing: 'border-box' }}
              placeholder="Write the answer the agent should give — a fact, policy, or link…"
              value={learnEdits[l.key] ?? ''}
              onChange={(e) =>
                setLearnEdits((s) => ({ ...s, [l.key]: e.target.value }))
              }
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn primary"
                disabled={approve.isPending || !(learnEdits[l.key] ?? '').trim()}
                onClick={() =>
                  approve.mutate({ key: l.key, entry: learnEdits[l.key].trim() })
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
  category?: string | null;
  human_result?: 'pass' | 'fail' | 'unreviewed' | 'fixed_recheck' | null;
  stale?: boolean;
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
  // "Try in chat" seeds the shared docked test chat — the same loop the
  // builder's Try step uses, available post-launch on this page too.
  const dock = useDock();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [batch, setBatch] = useState<{
    batchId: string;
    total: number;
    kind: 'manual' | 'ab';
    startedAt: number;
  } | null>(null);
  // Paged suite — ?limit= opts the endpoint into cursor mode; the server
  // owns filter/sort/counts so the toolbar can't lie about unloaded rows.
  // Key stays under ['agent-tests', agentId] so every existing invalidate
  // (verdict writes, deletes, imports, runs) reaches it.
  const [testQuery, setTestQuery] = useState<{ filter: ScenarioFilter; sort: ScenarioSort }>({
    filter: 'all',
    sort: 'attention',
  });
  // Rows jumped-to by id that live beyond the loaded pages — fetched on
  // demand and mounted ahead of the slice.
  const [injected, setInjected] = useState<Record<string, AgentTest>>({});
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['agent-tests', agentId, 'paged', testQuery.filter, testQuery.sort],
    queryFn: ({ pageParam }) =>
      api<{
        tests: AgentTest[];
        next_cursor: string | null;
        counts: ScenarioCounts;
      }>(
        `/api/agents/${agentId}/tests?limit=100&filter=${testQuery.filter}&sort=${testQuery.sort}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    // While a suite runs, last_run lands per test — poll so checkmarks
    // light up live instead of appearing all at once at the end.
    refetchInterval: batch ? 3000 : false,
  });
  const { data: runsData } = useQuery({
    queryKey: ['agent-test-runs', agentId],
    queryFn: () => api<{ batches: EvalBatch[] }>(`/api/agents/${agentId}/test-runs`),
    refetchInterval: batch ? 2500 : false,
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
  // Regression triage — after a scheduled suite regresses, the eval.triage
  // job classifies each flip and drafts a fix; verified ones replayed the
  // whole suite against the candidate and greened it without breakage.
  const { data: evalSugData } = useQuery({
    queryKey: ['eval-suggestions', agentId],
    queryFn: () =>
      api<{
        suggestions: {
          id: string;
          batch_id: string;
          test_id: string | null;
          test_name: string | null;
          kind: 'knowledge_gap' | 'prompt_drift' | 'test_stale' | 'hypothesis';
          summary: string;
          patch:
            | { type: 'knowledge'; entry: string }
            | { type: 'system_prompt'; append: string }
            | { type: 'expectation'; test_id: string; expectation: string }
            | null;
          verified: { pass_rate: number | null; baseline_rate: number | null; broke: number } | null;
          created_at: string;
        }[];
      }>(`/api/agents/${agentId}/eval-suggestions`),
  });
  const [running, setRunning] = useState<string | null>(null);
  const [correctTarget, setCorrectTarget] = useState<{
    agentText: string;
    customerText?: string;
    scenarioId?: string;
  } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMsg, setNewMsg] = useState('');
  const [newExpectation, setNewExpectation] = useState('');
  const [err, setErr] = useState('');
  const [confirmEl, confirm] = useConfirm();

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['agent-tests', agentId] });

  // A delete must drop the row from EVERY cached view at once — injected
  // deep-link mounts live outside the paged query and would otherwise keep
  // rendering a scenario that no longer exists — then invalidate for the
  // server's truth.
  const dropTests = (gone: (t: AgentTest) => boolean) => {
    setInjected((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([, t]) => !gone(t)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    qc.setQueriesData(
      { queryKey: ['agent-tests', agentId] },
      (
        old: { pages?: { tests: AgentTest[] }[]; tests?: AgentTest[] } | undefined,
      ) =>
        old?.pages
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                tests: p.tests.filter((t) => !gone(t)),
              })),
            }
          : old?.tests
            ? { ...old, tests: old.tests.filter((t) => !gone(t)) }
            : old,
    );
    invalidate();
  };

  // Human verdicts on rows — same PATCH the Try-step and test-chat thumbs
  // write; a fail also opens the diagnose card on the stored reply.
  const markTest = useMutation({
    mutationFn: ({ id, result }: { id: string; result: 'pass' | 'fail' }) =>
      api(`/api/agents/${agentId}/tests/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ human_result: result }),
      }),
    onSuccess: invalidate,
    onError: (e) => setErr(e.message),
  });

  const runOne = useMutation({
    mutationFn: (testId: string) =>
      api(`/api/agents/${agentId}/tests/${testId}/run`, { method: 'POST' }),
    onSuccess: invalidate,
    onError: (e) => setErr(e.message),
    onSettled: () => setRunning(null),
  });
  // Suites run on the jobs path — the POST returns a batch id immediately
  // and rows land in /test-runs as each test completes. Poll for the batch
  // and treat done===total as finished (unrunnable tests still record a row).
  const activeBatch = batch ? runsData?.batches.find((b) => b.batch_id === batch.batchId) : undefined;
  const batchDone = activeBatch?.results.length ?? 0;
  useEffect(() => {
    if (!batch) return;
    const timedOut = Date.now() - batch.startedAt > 20 * 60_000;
    if (batchDone < batch.total && !timedOut) return;
    if (timedOut && batchDone < batch.total)
      setErr('suite run timed out — partial results are saved');
    if (batch.kind === 'ab' && activeBatch) {
      setAbResult({
        summary: {
          passed: activeBatch.passed,
          failed: activeBatch.failed,
          unrunnable: activeBatch.unrunnable,
        },
        results: activeBatch.results.map((r) => ({ name: r.name, passed: r.passed, reason: r.reason })),
      });
    }
    setBatch(null);
    invalidate();
    void qc.invalidateQueries({ queryKey: ['agent-test-runs', agentId] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch, batchDone, activeBatch]);

  const runAll = useMutation({
    mutationFn: () =>
      api<{ batch_id: string; total: number }>(`/api/agents/${agentId}/tests-run-all`, { method: 'POST' }),
    onSuccess: (d) => setBatch({ batchId: d.batch_id, total: d.total, kind: 'manual', startedAt: Date.now() }),
    onError: (e) => setErr(e.message),
  });
  // Variant A/B — replay the whole suite against different instructions
  // and/or a different model. Nothing saves back to the agent; the summary
  // is compared to the baseline pass count shown on the tests list.
  const [abOpen, setAbOpen] = useState(false);
  const [candidatePrompt, setCandidatePrompt] = useState('');
  const [candidateModel, setCandidateModel] = useState('');
  // Models the agent's endpoint can serve — the run merges the id over the
  // saved llm config, so a hosted agent picks from the metered catalog and
  // a BYOK agent from its own provider's list (null = still loading).
  const [abModels, setAbModels] = useState<ModelOption[] | null>(null);
  useEffect(() => {
    if (!abOpen || abModels !== null) return;
    let dead = false;
    const llm = ((agent.config ?? {}) as AgentConfig).llm as LlmBlock | undefined;
    const providerId = llm?.provider ?? detectProvider(llm) ?? METERED;
    const hosted = providerId === METERED;
    api<{
      models?: string[];
      accounts?: { vendor: string; base_url: string; models: string[]; error?: string }[];
    }>(`/api/agents/${agentId}/llm-models`, {
      method: 'POST',
      // BYOK sends its base_url so the server applies the stored key;
      // hosted asks for the metered provider accounts.
      body: JSON.stringify(hosted ? { metered: true } : { base_url: llm?.base_url }),
    })
      .then((r) => {
        if (dead) return;
        const opts: ModelOption[] = [];
        const push = (o: ModelOption) => {
          if (!opts.some((x) => x.id === o.id)) opts.push(o);
        };
        if (hosted) {
          // Mirror LlmEditor's hosted list — catalog + live ids, priced
          // only (unpriced models can't be billed on the metered side).
          const priced = (o: ModelOption) => catalogRateFor(o.id) != null;
          for (const acc of r.accounts ?? []) {
            if (acc.error) continue;
            const vend =
              acc.vendor === 'default' || acc.vendor === 'openrouter'
                ? undefined
                : (acc.vendor as LlmVendor);
            for (const o of catalogOptions(vend ? [vend] : undefined).filter(priced)) push(o);
            const liveProvider =
              acc.vendor === 'openrouter' ? 'openrouter' : (providerForVendor(vend)?.id ?? 'custom');
            for (const o of filterLiveModels(liveProvider, acc.models).filter(priced)) push(o);
          }
        } else {
          // BYOK is unmetered — offer the provider's whole catalog + live list.
          for (const o of modelsForProvider(providerId)) push(o);
          for (const o of filterLiveModels(providerId, r.models ?? [])) push(o);
        }
        setAbModels(opts);
      })
      .catch(() => {
        if (!dead) setAbModels([]);
      });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abOpen]);
  const [abResult, setAbResult] = useState<{
    summary: { passed: number; failed: number; unrunnable: number };
    results: { name: string; passed: boolean | null; reason: string }[];
  } | null>(null);
  const abRun = useMutation({
    mutationFn: () =>
      api<{ batch_id: string; total: number }>(`/api/agents/${agentId}/tests-run-all`, {
        method: 'POST',
        body: JSON.stringify({
          ...(candidatePrompt.trim() ? { system_prompt: candidatePrompt } : {}),
          ...(candidateModel.trim() ? { model: candidateModel.trim() } : {}),
        }),
      }),
    onSuccess: (d) => setBatch({ batchId: d.batch_id, total: d.total, kind: 'ab', startedAt: Date.now() }),
    onError: (e) => setErr(e.message),
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
    onSuccess: (_r, testId) => dropTests((t) => t.id === testId),
    onError: (e) => setErr(e.message),
  });
  const delGroup = useMutation({
    mutationFn: (sourceConvId: string) =>
      api(`/api/agents/${agentId}/tests?source=${sourceConvId}`, { method: 'DELETE' }),
    onSuccess: (_r, sourceConvId) => dropTests((t) => t.source_conversation_id === sourceConvId),
    onError: (e) => setErr(e.message),
  });
  const saveExp = useMutation({
    mutationFn: (b: { id: string; text: string }) =>
      api(`/api/agents/${agentId}/tests/${b.id}`, {
        method: 'PATCH',
        // Re-judge the stored reply under the new bar — a fresh run would
        // produce a different reply and change what's being measured.
        body: JSON.stringify({ expectation: b.text, rejudge: true }),
      }),
    onSuccess: invalidate,
    onError: (e) => setErr(e.message),
  });
  const create = useMutation({
    mutationFn: () =>
      api(`/api/agents/${agentId}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          // Blank name → the API titles the scenario from the trigger,
          // the same default the chat/inbox saves use.
          ...(newName.trim() ? { name: newName.trim() } : {}),
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

  const decideEvalSug = useMutation({
    mutationFn: (b: { id: string; action: 'apply' | 'dismiss' }) =>
      api(`/api/agents/${agentId}/eval-suggestions/${b.id}/${b.action}`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['eval-suggestions', agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['agent-tests', agentId] });
    },
    onError: (e) => setErr(e.message),
  });

  const tests = useMemo(() => {
    const flat = (data?.pages ?? []).flatMap((p) => p.tests);
    const extra = Object.values(injected).filter((t) => !flat.some((f) => f.id === t.id));
    return [...extra, ...flat];
  }, [data, injected]);
  const testCounts = data?.pages[0]?.counts;
  // A reveal can name a row beyond the loaded pages — fetch it by id and
  // mount it ahead of the slice, then reveal normally (its frame polling
  // covers the mount commit).
  const revealMissing = (id: string) => {
    void api<{ test: AgentTest }>(`/api/agents/${agentId}/tests/${id}`)
      .then((d) => {
        setInjected((prev) => ({ ...prev, [id]: d.test }));
        revealScenario(id);
      })
      .catch(() => {});
  };
  const { hash } = useLocation();
  // Deep links land as #sc-<id> ("see matched scenario" from inbox/test
  // chat) — revealScenario unfolds the row, opens any group it's nested
  // in, drops a hiding filter, then rings + scrolls the live element.
  useEffect(() => {
    if (!tests.length || !hash.startsWith('#sc-')) return;
    revealScenario(hash.slice(4));
  }, [tests.length, hash]);
  const passed = testCounts?.passing ?? tests.filter(isPassing).length;
  const failed = testCounts?.failing ?? tests.filter(isFailing).length;
  const batches = runsData?.batches ?? [];
  const suggestions = suggestionsData?.suggestions ?? [];
  const evalSuggestions = evalSugData?.suggestions ?? [];
  // Actionable first: verified patches, then unverified patches, then
  // hypotheses — so the bulk of a regression queue clears top-down.
  const rankSug = (s: (typeof evalSuggestions)[number]) =>
    s.verified && s.patch ? 0 : s.patch ? 1 : 2;
  const evalSuggestionsSorted = [...evalSuggestions].sort((a, b) => rankSug(a) - rankSug(b));
  const verifiedCount = evalSuggestions.filter((s) => s.verified && s.patch).length;

  // Bulk triage. Applies run sequentially — each one rewrites agent
  // config, so parallel writes could clobber each other. Dismissals only
  // flip a row's own status, so they fan out.
  const applyAllVerified = useMutation({
    mutationFn: async () => {
      for (const s of evalSuggestionsSorted.filter((s) => s.verified && s.patch)) {
        await api(`/api/agents/${agentId}/eval-suggestions/${s.id}/apply`, { method: 'POST' });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['eval-suggestions', agentId] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['agent-tests', agentId] });
    },
    onError: (e) => setErr(e.message),
  });
  const dismissAllEval = useMutation({
    mutationFn: () =>
      Promise.all(
        evalSuggestions.map((s) =>
          api(`/api/agents/${agentId}/eval-suggestions/${s.id}/dismiss`, { method: 'POST' }),
        ),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['eval-suggestions', agentId] }),
    onError: (e) => setErr(e.message),
  });
  const saveAllRescued = useMutation({
    mutationFn: async () => {
      for (const s of suggestions) {
        await api(`/api/agents/${agentId}/tests`, {
          method: 'POST',
          body: JSON.stringify({ name: `${s.name} — rescue`, conversation_id: s.conversation_id }),
        });
      }
    },
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['test-suggestions', agentId] });
    },
    onError: (e) => setErr(e.message),
  });
  const dismissAllRescued = useMutation({
    mutationFn: () => {
      const config = { ...(agent.config ?? {}) } as AgentConfig;
      config.dismissed_test_suggestions = [
        ...(config.dismissed_test_suggestions ?? []),
        ...suggestions.map((s) => s.conversation_id),
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

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
      <ReadOnly off={!isAdmin}>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <strong>Scenarios</strong>
          <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
            saved conversations replayed against this agent's current setup
          </span>
          {tests.length > 0 && (
            <span style={{ fontSize: 12, marginLeft: 8 }}>
              <span style={{ color: 'var(--accent)' }}>{passed} passing</span>
              {failed > 0 && (
                <span style={{ color: 'var(--danger)' }}> · {failed} failing</span>
              )}
            </span>
          )}
        </div>
        {tests.length > 0 && (
          <label
            className="row"
            style={{ gap: 4, fontSize: 12, whiteSpace: 'nowrap' }}
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
        {tests.length > 0 && (
          <button
            className="btn icon sm"
            disabled={running !== null || batch !== null}
            onClick={() => setAbOpen(true)}
            title="Try a variant — replay every scenario against different instructions or a different model, before you change the real agent"
          >
            <FlaskConical size={14} />
          </button>
        )}
        <button
          className="btn icon sm"
          onClick={() => setImportOpen(true)}
          title="Import scenarios from CSV"
        >
          <Upload size={14} />
        </button>
        <button className="btn sm" onClick={() => setNewOpen(true)}>
          + New
        </button>
        {tests.length > 0 && (
          <button
            className="btn primary sm"
            disabled={running !== null || batch !== null}
            onClick={() => runAll.mutate()}
          >
            {batch ? `Running… ${batchDone}/${batch.total}` : 'Run all'}
          </button>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Save a transcript from any conversation ("Save as scenario") — each point a human
        stepped in becomes its own scenario. Replays never message customers or run tools;
        add an expectation and each run is judged against it.
      </div>
      {evalSuggestions.length > 0 && (
        <details className="card" style={{ padding: '10px 16px' }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>
            {evalSuggestions.length} suggested fix{evalSuggestions.length === 1 ? '' : 'es'}
            <span className="muted">
              {' '}— {verifiedCount > 0 ? `${verifiedCount} verified · ` : ''}drafted from the last regressed run
            </span>
          </summary>
          <ReadOnly off={!isAdmin}>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              {verifiedCount > 0 && (
                <button
                  className="btn sm"
                  disabled={applyAllVerified.isPending || decideEvalSug.isPending}
                  onClick={() => applyAllVerified.mutate()}
                  title="Apply every suggestion whose patch was replay-verified against the suite"
                >
                  {applyAllVerified.isPending ? 'Applying…' : `Apply ${verifiedCount} verified`}
                </button>
              )}
              <button
                className="btn ghost sm"
                disabled={dismissAllEval.isPending || decideEvalSug.isPending}
                onClick={async () => {
                  if (await confirm(`Dismiss all ${evalSuggestions.length} suggestions? Nothing is applied — the queue just clears.`))
                    dismissAllEval.mutate();
                }}
              >
                {dismissAllEval.isPending ? 'Dismissing…' : 'Dismiss all'}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                verified fixes replayed clean; the rest need a human look
              </span>
            </div>
          </ReadOnly>
          <div style={{ marginTop: 8 }}>
          {evalSuggestionsSorted.map((s) => {
            const KIND_LABEL: Record<string, string> = {
              knowledge_gap: 'knowledge gap',
              prompt_drift: 'prompt fix',
              test_stale: 'stale scenario',
              hypothesis: 'hypothesis',
            };
            const pct = (v: number | null) =>
              v === null ? '—' : `${Math.round(v * 100)}%`;
            const patchBlock = { borderLeft: '2px solid var(--border)', paddingLeft: 8, marginTop: 4, whiteSpace: 'pre-wrap' as const, color: 'var(--text)' };
            // The evidence behind the diagnosis: which scenario flipped in
            // which run, the trigger, the bar, and what the agent actually
            // said — without it, Apply is a blind bet.
            const linkedTest = s.test_id ? tests.find((t) => t.id === s.test_id) : undefined;
            const batch = s.batch_id ? batches.find((b) => b.batch_id === s.batch_id) : undefined;
            return (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '8px 0',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <details style={{ flex: 1, minWidth: 0 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
                    <span
                      className="muted"
                      style={{
                        fontSize: 11,
                        textTransform: 'uppercase',
                        letterSpacing: 0.4,
                        marginRight: 6,
                      }}
                    >
                      {KIND_LABEL[s.kind] ?? s.kind}
                    </span>
                    {s.test_name ? `${s.test_name} — ` : ''}
                    {s.summary}
                    {s.verified && (
                      <span style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 700 }}>
                        {' '}✓ verified
                      </span>
                    )}
                  </summary>
                  <div
                    className="muted"
                    style={{
                      margin: '6px 0 4px 18px',
                      fontSize: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div>
                      {s.verified ? (
                        <span style={{ color: 'var(--accent)' }}>
                          {s.kind === 'test_stale'
                            ? 'verified — the stored reply passes under this expectation'
                            : `verified — replayed against the suite: passes ${pct(s.verified.pass_rate)} (was ${pct(s.verified.baseline_rate)}), no breakage`}
                        </span>
                      ) : s.patch ? (
                        <span style={{ color: 'var(--danger)' }}>
                          unverified — drafted, but the replay didn't confirm it helps
                        </span>
                      ) : (
                        'hypothesis — a diagnosis to read, not a ready fix'
                      )}
                      {` · ${timeAgo(s.created_at)}`}
                    </div>
                    {s.test_id && !linkedTest && (
                      <div>The scenario it was flagged on no longer exists.</div>
                    )}
                    {linkedTest && (
                      <div>
                        On scenario{' '}
                        <a
                          href={`#sc-${linkedTest.id}`}
                          style={{ color: 'var(--accent)' }}
                          onClick={() => revealScenario(linkedTest.id)}
                        >
                          "{linkedTest.name}"
                        </a>
                        {batch && (
                          <span>
                            {' '}— flagged by the{' '}
                            {batch.kind === 'ab' ? 'A/B' : batch.kind} run {timeAgo(batch.at)}
                          </span>
                        )}
                        :
                        <div style={patchBlock}>
                          <div>Customer: {scenarioPrompt(linkedTest)}</div>
                          {linkedTest.expectation && <div>Expected: {linkedTest.expectation}</div>}
                          {linkedTest.last_run?.reply && (
                            <div className="scenario-reply-clamp">Agent said: {linkedTest.last_run.reply}</div>
                          )}
                          {linkedTest.source_conversation_id && (
                            <div>
                              <Link
                                to={`/conversations/${linkedTest.source_conversation_id}`}
                                style={{ color: 'var(--accent)' }}
                              >
                                source conversation →
                              </Link>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {s.patch?.type === 'knowledge' && (
                      <div>
                        Applying adds this to the knowledge base:
                        <div style={patchBlock}>{s.patch.entry}</div>
                      </div>
                    )}
                    {s.patch?.type === 'system_prompt' && (
                      <div>
                        Applying appends this to the agent's instructions:
                        <div style={patchBlock}>{s.patch.append}</div>
                      </div>
                    )}
                    {s.patch?.type === 'expectation' && (
                      <div>
                        Applying rewrites the expectation on "{s.test_name ?? 'the scenario'}" to:
                        <div style={patchBlock}>{s.patch.expectation}</div>
                      </div>
                    )}
                    {!s.patch && (
                      <div>No patch attached — dismiss it, or open the scenario to investigate.</div>
                    )}
                    <div>Dismiss just removes the suggestion — the agent doesn't change.</div>
                  </div>
                </details>
                <ReadOnly off={!isAdmin}>
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0, paddingTop: 2 }}>
                  {s.patch && (
                    <button
                      className="btn sm"
                      onClick={() => decideEvalSug.mutate({ id: s.id, action: 'apply' })}
                      disabled={decideEvalSug.isPending}
                    >
                      {s.verified ? 'Apply fix' : 'Apply anyway'}
                    </button>
                  )}
                  <button
                    className="btn ghost sm"
                    title="Remove the suggestion — nothing is applied"
                    onClick={() => decideEvalSug.mutate({ id: s.id, action: 'dismiss' })}
                    disabled={decideEvalSug.isPending}
                  >
                    dismiss
                  </button>
                  </div>
                </ReadOnly>
              </div>
            );
          })}
          </div>
        </details>
      )}
      {suggestions.length > 0 && (
        <details className="card" style={{ padding: '10px 16px' }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>
            {suggestions.length} rescued conversation{suggestions.length === 1 ? '' : 's'}
            <span className="muted"> — not yet covered by a scenario</span>
          </summary>
          <ReadOnly off={!isAdmin}>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <button
                className="btn sm"
                disabled={saveAllRescued.isPending || saveSuggestion.isPending}
                onClick={() => saveAllRescued.mutate()}
                title="Save every listed conversation as scenarios — one per rescue point"
              >
                {saveAllRescued.isPending ? 'Saving…' : 'Save all as tests'}
              </button>
              <button
                className="btn ghost sm"
                disabled={dismissAllRescued.isPending || dismissSuggestion.isPending}
                onClick={async () => {
                  if (await confirm(`Dismiss all ${suggestions.length} rescued conversations? They won't be suggested again.`))
                    dismissAllRescued.mutate();
                }}
              >
                {dismissAllRescued.isPending ? 'Dismissing…' : 'Dismiss all'}
              </button>
            </div>
          </ReadOnly>
          <div style={{ marginTop: 8 }}>
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
        </details>
      )}
      {err && <div className="error">{err}</div>}

      {importOpen && (
        <Modal title="Import scenarios" onClose={() => setImportOpen(false)}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            One scenario per line: <code>name, customer message, expectation</code>. Paste from a
            spreadsheet or export. Multi-turn scenarios still come from "Save as scenario" on a conversation.
          </div>
          <textarea
            rows={6}
            autoFocus
            placeholder={'name (optional), prompt, expectation\nrefund request, "I want my money back", "Never promises a refund; offers human follow-up"'}
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
              {importCsv.isPending ? 'Importing…' : 'Import scenarios'}
            </button>
          </div>
        </Modal>
      )}

      {abOpen && (
        <Modal title="Try a variant" onClose={() => setAbOpen(false)} width={620}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Thinking of changing the instructions or the model? Try it here
            first — every scenario re-runs against your version and reports
            pass/fail next to today's results. Your agent is untouched; if the
            variant wins, adopt it yourself in Behavior.
          </div>
          <label style={{ fontSize: 12 }}>Instructions</label>
          <textarea
            rows={6}
            autoFocus
            placeholder="New instructions (optional — blank keeps today's)"
            value={candidatePrompt}
            onChange={(e) => setCandidatePrompt(e.target.value)}
            style={{ width: '100%' }}
          />
          <label style={{ fontSize: 12, marginTop: 8, display: 'block' }}>Model</label>
          <ModelPicker
            value={candidateModel}
            options={[{ id: '', name: 'Same as today' }, ...(abModels ?? [])]}
            onChange={setCandidateModel}
            disabled={abModels === null}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn primary sm"
              disabled={(!candidatePrompt.trim() && !candidateModel.trim()) || running !== null || batch !== null}
              onClick={() => { setAbResult(null); abRun.mutate(); }}
            >
              {batch ? `Running… ${batchDone}/${batch.total}` : 'Run scenarios vs this'}
            </button>
          </div>
          {abResult && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              <strong>
                Variant: {abResult.summary.passed} passed, {abResult.summary.failed} failed
                {abResult.summary.unrunnable > 0 && `, ${abResult.summary.unrunnable} unrunnable`}
              </strong>
              <span className="muted"> (today: {passed} passing)</span>
              {abResult.results.filter((r) => r.passed === false).map((r) => (
                <div key={r.name} className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  ✗ {r.name} — {r.reason}
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {newOpen && (
        <Modal title="New scenario" onClose={() => setNewOpen(false)}>
          <input
            placeholder="Name (optional — defaults to the customer message)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ width: '100%', marginBottom: 8 }}
          />
          <textarea
            rows={2}
            autoFocus
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
              disabled={!newMsg.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Saving…' : 'Create scenario'}
            </button>
          </div>
        </Modal>
      )}

      {tests.length === 0 && !newOpen && (
        <div className="muted" style={{ fontSize: 13 }}>
          No scenarios yet. Open a conversation — especially one a human had to rescue — and hit
          "Save as scenario" to lock in what a good reply looks like.
        </div>
      )}

      {(tests.length > 0 || (testCounts?.all ?? 0) > 0) && (
        <ScenarioList
          tests={tests}
          groupBy="conversation"
          paged={{
            counts: testCounts ?? { all: 0, failing: 0, passing: 0, unrun: 0 },
            hasMore: !!hasNextPage,
            loadingMore: isFetchingNextPage,
            onLoadMore: () => void fetchNextPage(),
            onQueryChange: (q) => {
              // New slice — injected jump-targets drop with it.
              setInjected({});
              setTestQuery(q);
            },
            onRevealMissing: revealMissing,
          }}
          onDeleteGroup={isAdmin ? (id) => delGroup.mutate(id) : undefined}
          deletingGroup={delGroup.isPending}
          renderRow={(t, foldSignal) => (
            <ScenarioRow
              key={t.id}
              test={t}
              running={running === t.id}
              foldSignal={foldSignal}
              disabled={running !== null || batch !== null}
            onRun={() => { setRunning(t.id); runOne.mutate(t.id); }}
            onDelete={isAdmin ? () => del.mutate(t.id) : undefined}
            onSaveExpectation={
              isAdmin ? (text) => saveExp.mutate({ id: t.id, text }) : undefined
            }
            expectationSaving={saveExp.isPending}
            onFix={(reply, prompt) =>
              setCorrectTarget({
                agentText: reply,
                customerText: prompt,
                scenarioId: t.id,
              })
            }
            onTryInChat={
              dock?.testAvailable
                ? () => dock.sendTestSeed(scenarioPrompt(t))
                : undefined
            }
            reviewRequired={
              ((agent.config ?? {}) as AgentConfig).builder?.domain_risk === 'elevated' &&
              t.category === 'safety' &&
              t.human_result !== 'pass' &&
              t.human_result !== 'fail'
            }
            verdict={
              isAdmin
                ? {
                    pending: markTest.isPending,
                    onPass: () => markTest.mutate({ id: t.id, result: 'pass' }),
                    onFail: () => {
                      markTest.mutate({ id: t.id, result: 'fail' });
                      setCorrectTarget({
                        agentText: t.last_run?.reply ?? '',
                        customerText: scenarioPrompt(t),
                        scenarioId: t.id,
                      });
                    },
                  }
                : undefined
            }
            />
          )}
        />
      )}

      {batches.length > 0 && (
        <details>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
            Run history — {batches.length} suite{batches.length === 1 ? '' : 's'}
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
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
        </details>
      )}
      {/* A failed regression has the same repair path a Try-it miss does —
          the diagnose card, as a modal, same component. */}
      {correctTarget && (
        <div className="modal-backdrop" onClick={() => setCorrectTarget(null)}>
          <div
            className="modal"
            style={{ width: 560, maxHeight: '78vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <CorrectThisCard
              agentId={agentId}
              cfg={(agent.config ?? {}) as AgentConfig}
              target={{
                agentText: correctTarget.agentText,
                customerText: correctTarget.customerText,
                ...(correctTarget.scenarioId
                  ? {
                      scenario: {
                        id: correctTarget.scenarioId,
                        expectation:
                          tests.find((x) => x.id === correctTarget.scenarioId)
                            ?.expectation ?? '',
                      },
                    }
                  : {}),
              }}
              onClose={() => setCorrectTarget(null)}
              onSaved={() => {
                invalidate();
                void qc.invalidateQueries({ queryKey: ['agents'] });
              }}
              onFixed={(scenarioId) => {
                setRunning(scenarioId);
                runOne.mutate(scenarioId);
              }}
              onDeleted={(scenarioId) => dropTests((t) => t.id === scenarioId)}
              onGoStep={(s) => navigate(`/agents/new/${agentId}?step=${s}`)}
            />
          </div>
        </div>
      )}
      {confirmEl}
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
