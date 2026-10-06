import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAgents, useBuildStatus, useMe } from '../api/hooks';
import { janisBrain, setLastAgent } from '../lib/agentContext';
import { useDock } from '../lib/dockContext';
import { railBus } from '../lib/railBus';
import { stepGlyph, stepSubtitle, useSeenSteps } from '../lib/seenSteps';
import { usePageTitle } from '../lib/title';
import type { Agent, AgentConfig } from '@janis/shared';
import { ChevronDown } from 'lucide-react';
import { AskJanis } from '../components/AskJanis';
import { CorrectThisCard } from '../components/CorrectThis';
import { AgentChannels } from '../components/AgentChannels';
import { SourceList, type KnowledgeBudget } from '../components/SourceList';
import {
  GreetingSection,
  InstructionsSection,
  KnowledgeGaps,
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
  suggested_knowledge?: { id: string; text: string; priority?: 'high' | 'normal' }[];
  suggested_templates?: { id: string; name?: string; reason?: string }[];
  suggested_approvals?: string[];
  suggested_rules?: string[];
  suggested_questions?: string[];
  knowledge_need?: 'required' | 'helpful' | 'unnecessary';
  knowledge_need_reason?: string;
  region_sensitive?: boolean;
  domain_risk?: 'low' | 'elevated';
  suggested_channels?: ('bubble' | 'meta' | 'gmail' | 'outlook' | 'email' | 'voice' | 'sms')[];
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

/** Teach it sub-surfaces — one unified source list (websites, files,
 *  notes, and help-center articles all land in it); Gaps earns a tab only
 *  when real conversations produced them. */
const TEACH_SUBS = [
  { key: 'sources', label: 'Sources' },
  { key: 'gaps', label: 'Gaps' },
] as const;
type TeachSub = (typeof TEACH_SUBS)[number]['key'];
const teachSubKey = (agentId: string) => `janis.teach-sub.${agentId}`;

// Try-it scenario categories — safety leads so an elevated-risk agent
// can't look tested on office-hours questions alone.
const CAT_ORDER = ['safety', 'knowledge', 'actions', 'out_of_scope', 'tone', 'general'];
/** "Change the greeting", "add a booking tool", "update your instructions"
 *  — typed into the test chat these read as setup requests meant for
 *  Copilot. Loose on purpose: it only nudges, never blocks. */
const CONFIG_HINT_RE =
  /\b(change|update|edit|rename|add|remove|delete|enable|disable|turn (?:on|off)|connect|configure|set up|make)\b[^.!?]{0,80}\b(agent|greeting|prompt|instruction|rule|knowledge|article|tool|abilit|channel|name|color|tone|widget|handoff|booking|calendar|setting|config|reply|answer|personality|voice)/i;

const CAT_LABELS: Record<string, string> = {
  safety: 'Safety & escalation',
  knowledge: 'Knowledge',
  actions: 'Actions',
  out_of_scope: 'Out of scope',
  tone: 'Tone & style',
  general: 'General',
};

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
  const subParam = params.get('sub');

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
      // Straight into the flow — land on the first step this agent actually
      // needs: a draft that suggested no knowledge skips Teach it (it's an
      // optional capability, not a skipped task).
      // Always land on Teach it — it's the first surface where the user
      // adds what only they know, even when the draft suggested nothing.
      navigate(`/agents/new/${r.agent.id}?step=teach`, { replace: true });
    },
    onError: (e) => setError(e.message),
  });

  // Shared config draft — the same {config} PATCH the agent editor uses.
  const [cfg, setCfg] = useState<AgentConfig>({});
  const [saved, setSaved] = useState(false);
  const [legendSeen, setLegendSeen] = useState(() => {
    try { return localStorage.getItem('janis.step-legend.v1') === '1'; } catch { return true; }
  });
  useEffect(() => {
    setCfg(agent?.config ?? {});
  }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveCfg = useMutation({
    mutationFn: () => {
      // Saving on Guide it counts as review — a human looked at the draft
      // and kept it, so the step marks confirmed, not "drafted by Janis".
      // On Teach it, facts written under a topic's "Writing for" context
      // count it covered — text lines can't carry a tag like file rows.
      const coverActive =
        step === 'teach' &&
        activeTopic &&
        teachSub === 'sources' &&
        (cfg.knowledge ?? []).some((l) => l.trim());
      const config: AgentConfig = {
        ...cfg,
        builder: {
          ...cfg.builder,
          ...(step === 'guide' ? { guide_confirmed: true } : {}),
          ...(coverActive
            ? {
                covered_topics: [
                  ...new Set([...(cfg.builder?.covered_topics ?? []), activeTopic!.id]),
                ],
              }
            : {}),
        },
      };
      return api(`/api/agents/${agent?.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ config }),
      }).then(() => config);
    },
    onSuccess: (config) => {
      setCfg(config);
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['build-status', agent?.id] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      markDrift();
    },
    onError: (e) => setError(e.message),
  });
  // One-flag writes — "Looks good" on Guide it, "none needed" on
  // Abilities, "Skip" on Teach it. These are what turn ◐ into ✓ (or the
  // muted ✓ of a deliberate skip).
  const confirmFlag = useMutation({
    mutationFn: (patch: Partial<NonNullable<AgentConfig['builder']>>) => {
      const config: AgentConfig = {
        ...cfg,
        builder: { ...cfg.builder, ...patch },
      };
      return api(`/api/agents/${agent?.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ config }),
      }).then(() => config);
    },
    onSuccess: (config) => {
      setCfg(config);
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['build-status', agent?.id] });
      markDrift();
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
  // Docked test panel — the same private channel Try it uses, openable
  // from any build step so feedback is never a rail-jump away. Lazy:
  // the channel row is created on first open (or on Try it), not load.
  // The unified dock owns the strip/panel chrome — this page registers as
  // the Test tab's provider and portals its wired panel into the slot.
  const dock = useDock();
  const testOpen = Boolean(dock?.open && dock.tab === 'test');
  const setDockOpen = (open: boolean) => {
    if (open) dock?.openTab('test');
    else dock?.setOpen(false);
  };
  // "This page provides the Test tab's content" — Layout hides its fallback
  // chat while a wired panel can be portaled in.
  const dockAvailableForReg = !!agent && hosted;
  useEffect(() => {
    if (!dock || !dockAvailableForReg) return;
    dock.setTestProvided(true);
    return () => dock.setTestProvided(false);
  }, [dock, dockAvailableForReg]);
  // ?rail=test&agent=<id>&q=<prompt> deeplinks (and concierge "run this"
  // links) land as a seed on the shared dock state.
  useEffect(() => {
    if (!dock?.testSeed) return;
    setSeed({ text: dock.testSeed.text, nonce: dock.testSeed.nonce, target: 'dock' });
    dock.openTab('test');
    dock.clearTestSeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock?.testSeed]);
  useEffect(() => {
    if ((step === 'try' || testOpen) && agent && hosted && !testChannel.data && !testChannel.isPending) {
      testChannel.mutate();
    }
  }, [step, testOpen, agent?.id, hosted]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Save & test" focuses the composer once the panel is open.
  const [chatFocus, setChatFocus] = useState(0);
  // New chat — a fresh cust_ visitor starts a NEW persistent conversation
  // on the internal channel; earlier threads stay in the inbox where they
  // remain useful for alert and takeover testing.
  const [chatVisitor, setChatVisitor] = useState<string | null>(null);
  const newChat = () => {
    setChatVisitor(
      (crypto.randomUUID?.() ??
        `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`
      ).replace(/-/g, ''),
    );
    setChatActive(false);
    setCfgDrifted(false);
  };
  // The Test tab's content comes from this page — the dock chrome (strip,
  // tabs, push/overlay behavior) is Layout's. The slot only exists while
  // the dock is open.
  const dockAvailable = !!agent && hosted && step !== 'start' && step !== 'bring';
  // On the Try step the dock IS the surface — open it on the Test tab once
  // per agent; after that, the operator's open/closed choice wins.
  useEffect(() => {
    if (step !== 'try' || !agent || !hosted || !dock) return;
    const k = `janis.try-dock.${agent.id}`;
    try {
      if (localStorage.getItem(k)) return;
      localStorage.setItem(k, '1');
    } catch {
      /* private mode */
    }
    dock.openTab('test');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, agent?.id, hosted, dock]);

  const { data: gapData } = useQuery({
    queryKey: ['knowledge-gaps', agent?.id],
    queryFn: () =>
      api<{ gaps: { key: string; count: number; questions: string[]; added: boolean }[] }>(
        `/api/agents/${agent?.id}/knowledge-gaps`,
      ),
    enabled: Boolean(agent && hosted && (step === 'try' || step === 'teach')),
  });
  const openGaps = (gapData?.gaps ?? []).filter((g) => !g.added);
  // Source counts for the Teach it tabs — same queries the sections use,
  // so numbers can't drift between builder and workspace surfaces.
  const { data: knowledgeData } = useQuery({
    queryKey: ['knowledge', agent?.id],
    queryFn: () =>
      api<{
        files: { source_url: string | null; topic: string | null }[];
        budget: KnowledgeBudget;
      }>(`/api/agents/${agent?.id}/knowledge`),
    enabled: Boolean(agent && hosted && step === 'teach'),
  });
  const { data: articlesData } = useQuery({
    queryKey: ['articles', agent?.id],
    queryFn: () => api<{ articles: { id: string }[] }>(`/api/articles?agent_id=${agent?.id}`),
    enabled: Boolean(agent && hosted && step === 'teach'),
  });
  const knowledgeFiles = knowledgeData?.files ?? [];
  const noteLines = Array.isArray(cfg.knowledge)
    ? cfg.knowledge.filter((l) => l.trim()).length
    : 0;
  const teachSubCount: Record<TeachSub, number> = {
    sources: knowledgeFiles.length + noteLines + (articlesData?.articles?.length ?? 0),
    gaps: openGaps.length,
  };
  const totalSources = teachSubCount.sources;
  // Gaps only earns a tab once real conversations produce them — on a
  // fresh agent it would be a cryptic empty panel.
  const visibleTeachSubs = TEACH_SUBS.filter((t) => t.key !== 'gaps' || openGaps.length > 0);
  const LEGACY_SUBS: Record<string, TeachSub> = {
    websites: 'sources',
    files: 'sources',
    text: 'sources',
    help: 'sources',
  };
  const storedSub = agentId
    ? (() => {
        try {
          return localStorage.getItem(teachSubKey(agentId));
        } catch {
          return null;
        }
      })()
    : null;
  const teachSub: TeachSub = visibleTeachSubs.some((t) => t.key === subParam)
    ? (subParam as TeachSub)
    : subParam && LEGACY_SUBS[subParam]
      ? LEGACY_SUBS[subParam]
      : visibleTeachSubs.some((t) => t.key === storedSub)
        ? (storedSub as TeachSub)
        : 'sources';
  const [activeTopic, setActiveTopic] = useState<{ id: string; text: string; priority?: 'high' | 'normal' } | null>(null);
  const goTeachSub = (s: TeachSub) => {
    try {
      if (agentId) localStorage.setItem(teachSubKey(agentId), s);
    } catch {
      /* private-mode quota — persistence just won't stick */
    }
    setActiveTopic(null);
    setTopicFocus(null);
    navigate(`/agents/new/${agent!.id}?step=teach&sub=${s}`, { replace: true });
  };

  const builder = cfg.builder;
  const { data: status } = useBuildStatus(agent?.id ?? undefined);
  const seenSteps = useSeenSteps(agent?.id);
  const idx = STEPS.findIndex((s) => s.key === step);
  // "Next" always points at the first step in rail order that hasn't been
  // opened yet — even if it's behind the current step, so jumping ahead
  // never orphans a skipped surface. Disappears once all steps have been
  // seen (Deploy itself never gets a Next). Create is excluded: an agent
  // that exists has by definition already been created.
  const seen = (k: StepKey) => seenSteps.has(k) || k === step;
  // "Next" goes to the next step that actually needs attention — pending
  // (nothing there) or partial (exists but unconfirmed/has gaps) — and
  // says why, not just where. Falls back to first-unseen while the
  // build-status query is still loading.
  const next = status
    ? STEPS.find(
        (s) =>
          s.key !== 'create' &&
          s.key !== step &&
          (status.steps[s.key] === 'pending' || status.steps[s.key] === 'partial'),
      )
    : idx >= 0 && idx < STEPS.length - 1
      ? STEPS.find((s) => s.key !== 'create' && !seen(s.key))
      : undefined;
  const nextReason = next
    ? ({
        teach: 'no sources yet',
        guide: status?.steps.guide === 'partial' ? 'drafted — take a look' : 'nothing there yet',
        abilities:
          status?.steps.abilities === 'partial'
            ? 'suggested — none connected'
            : 'nothing connected yet',
        try:
          status && status.test_conversations > 0
            ? 'open gaps to teach'
            : "you haven't tested yet",
        // Same string the rail carries — "added · no messages yet" vs
        // "no channel live yet" disagreeing was the bug.
        deploy: status ? stepSubtitle('deploy', status) : undefined,
      } as Partial<Record<StepKey, string>>)[next.key]
    : undefined;
  const nextLabel = next
    ? `Next: ${next.label}${nextReason ? ` · ${nextReason}` : ''}`
    : '';

  // Suggested topics — stored drafts may be plain strings (pre-priority)
  // or typed objects; both normalize to {id, text, priority}. Ids are
  // text slugs so a tagged source survives a rephrasing redraft.
  type Topic = { id: string; text: string; priority?: 'high' | 'normal' };
  const topicSlug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  const topics: Topic[] = (builder?.suggested_knowledge ?? [])
    .map((t): Topic | null => {
      if (typeof t === 'string') {
        const text = t.trim();
        return text ? { id: topicSlug(text), text } : null;
      }
      const text = (t.text ?? '').trim();
      return text ? { id: t.id || topicSlug(text), text, priority: t.priority } : null;
    })
    .filter((t): t is Topic => Boolean(t?.id && t.text));
  const rankedTopics = [...topics].sort(
    (a, b) => (b.priority === 'high' ? 1 : 0) - (a.priority === 'high' ? 1 : 0),
  );
  const [showAllTopics, setShowAllTopics] = useState(false);
  const visibleTopics = showAllTopics ? rankedTopics : rankedTopics.slice(0, 4);
  // Coverage is provable, not claimed: a source tagged to the topic, or
  // the operator's explicit "Mark as covered" (text facts can't tag).
  const topicCounts = new Map<string, number>();
  for (const f of knowledgeFiles) {
    if (f.topic) topicCounts.set(f.topic, (topicCounts.get(f.topic) ?? 0) + 1);
  }
  const coveredSet = new Set(builder?.covered_topics ?? []);
  const [topicFocus, setTopicFocus] = useState<'url' | 'file' | 'note' | null>(null);
  // Which topic's "Add source" menu is open — one small popover instead of
  // four inline links, the widest element on a narrow column.
  const [srcMenuFor, setSrcMenuFor] = useState<string | null>(null);
  const pickTopic = (t: Topic, focus: 'url' | 'file' | 'note') => {
    // The unified list keeps one surface — the topic action aims the
    // right affordance inside it instead of switching tabs.
    if (teachSub !== 'sources') goTeachSub('sources');
    setTopicFocus(focus);
    setActiveTopic(t);
  };
  const markCovered = (t: Topic) =>
    confirmFlag.mutate({ covered_topics: [...new Set([...coveredSet, t.id])] });
  const [guideOpen, setGuideOpen] = useState(false);
  // "Correct this" on a test-chat agent reply — the operator writes what
  // it should have said, then chooses where it lands: a private note, a
  // public article draft, or an instruction rule. The card itself is
  // shared with the inbox (CorrectThis.tsx).
  const [correctTarget, setCorrectTarget] = useState<{
    agentText: string;
    customerText?: string;
  } | null>(null);
  // Mid-chat config drift — a saved change while a test conversation has
  // messages means earlier replies ran the old config; nudge a fresh chat.
  const [chatActive, setChatActive] = useState(false);
  const [cfgDrifted, setCfgDrifted] = useState(false);
  const markDrift = () => {
    if (chatActive) setCfgDrifted(true);
  };
  // Try-asking chips — scenario prompts seed the test chat so the panel
  // and the checklist share one source of truth; falls back to the
  // draft's suggested questions while no scenarios exist. The nonce
  // bumps on every click so the same prompt can be sent again.
  const [seed, setSeed] = useState<{
    text: string;
    nonce: number;
    target: 'try' | 'dock';
  } | null>(null);
  const [testNotice, setTestNotice] = useState('');
  // Setup-shaped requests typed into the test chat (the owner forgets it
  // talks TO the agent) get a hint to move them to Copilot — heuristic,
  // not a block; dismissible.
  const [copilotHint, setCopilotHint] = useState<string | null>(null);
  // ── Try-it scenario runner ──────────────────────────────────────────
  // Scenarios are agent_tests rows — the same suite that runs post-launch
  // regression. Try it is the human-judgment layer: Run sends the prompt
  // into the docked panel on the real test pipeline, the reply comes back
  // through onAgentReply, and the operator marks Looks right / Needs work.
  interface ScenarioRow {
    id: string;
    name: string;
    turns: { role: 'customer' | 'agent'; text: string }[];
    expectation: string;
    category: string;
    source: string;
    human_result: 'pass' | 'fail' | 'unreviewed' | null;
    human_run_at: string | null;
    stale: boolean;
  }
  const testsQ = useQuery({
    queryKey: ['agent-tests', agent?.id],
    queryFn: () =>
      api<{ tests: ScenarioRow[]; config_version: string }>(
        `/api/agents/${agent?.id}/tests`,
      ),
    enabled: !!agent?.id && hosted,
    refetchInterval: 30_000,
  });
  const scenarios = testsQ.data?.tests ?? [];
  // First visit to the checklist materializes the draft's suggested
  // scenarios (bootstrap already seeds; this catches agents created
  // before suggestions existed or a regenerate that added new ones).
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !agent || !hosted || !testsQ.data) return;
    if (testsQ.data.tests.length || !builder?.suggested_scenarios?.length) return;
    seededRef.current = true;
    void api(`/api/agents/${agent.id}/tests-seed`, { method: 'POST' })
      .then(() => {
        void qc.invalidateQueries({ queryKey: ['agent-tests', agent.id] });
        void qc.invalidateQueries({ queryKey: ['build-status', agent.id] });
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testsQ.data, builder, agent?.id, hosted]);
  /** The customer message a scenario replays — last inbound turn for
   *  multi-turn transcript cases, the single turn for scenarios. */
  const scenarioPrompt = (s: ScenarioRow) =>
    [...(s.turns ?? [])].reverse().find((t) => t.role === 'customer')?.text ?? s.name;
  const [runningId, setRunningId] = useState<string | null>(null);
  const runQueueRef = useRef<string[]>([]);
  const replyRef = useRef<Map<string, string>>(new Map());
  const [repliesTick, bumpReplies] = useState(0);
  void repliesTick;
  const markTest = useMutation({
    mutationFn: ({ id, result }: { id: string; result: 'pass' | 'fail' | 'unreviewed' }) =>
      api(`/api/agents/${agent?.id}/tests/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ human_result: result }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-tests', agent?.id] });
      void qc.invalidateQueries({ queryKey: ['build-status', agent?.id] });
    },
  });
  const saveTest = useMutation({
    mutationFn: (ctx: { agentText: string; customerText?: string }) => {
      // A scenario is prompt + expected reply — with no customer text there
      // is no prompt, and falling back to the reply itself produces a
      // nonsense row that "asks" the agent its own answer.
      if (!ctx.customerText)
        throw new Error('No customer message to pair this reply with');
      return api(`/api/agents/${agent?.id}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: ctx.customerText.slice(0, 400),
          // The reply it gave IS the expectation — save-as-test means
          // "this was right, keep it that way".
          expectation: ctx.agentText.slice(0, 600),
          category: 'general',
          source: 'user',
        }),
      });
    },
    onSuccess: () => {
      setTestNotice('Added to the scenario list');
      void qc.invalidateQueries({ queryKey: ['agent-tests', agent?.id] });
      void qc.invalidateQueries({ queryKey: ['build-status', agent?.id] });
    },
    onError: (e) => setTestNotice(e.message),
  });
  // Sequential runner — one prompt in flight at a time so replies pair
  // unambiguously. A multi-bubble answer attaches to the running scenario;
  // the queue advances on a short delay after the first reply lands.
  const runTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advanceRun = (queue = runQueueRef.current) => {
    const id = queue.shift();
    const s = id ? scenarios.find((x) => x.id === id) : undefined;
    if (!s) {
      setRunningId(null);
      if (runTimeoutRef.current) clearTimeout(runTimeoutRef.current);
      return;
    }
    setRunningId(s.id);
    setSeed({ text: scenarioPrompt(s), nonce: Date.now(), target: 'dock' });
    // Stall guard — a reply that never comes (agent error, dropped send)
    // must not wedge the checklist on "Running…" forever.
    if (runTimeoutRef.current) clearTimeout(runTimeoutRef.current);
    runTimeoutRef.current = setTimeout(() => {
      runTimeoutRef.current = null;
      setTestNotice('No reply — marked unreviewed');
      advanceRun();
    }, 90_000);
  };
  const runScenario = (s: ScenarioRow) => {
    runQueueRef.current = [s.id];
    setDockOpen(true);
    advanceRun();
  };
  const runAll = () => {
    runQueueRef.current = scenarios.map((s) => s.id);
    setDockOpen(true);
    advanceRun();
  };
  const runAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onAgentReply = (text: string) => {
    if (!runningId) return;
    // Reply landed — the stall guard's job is done for this scenario.
    if (runTimeoutRef.current) {
      clearTimeout(runTimeoutRef.current);
      runTimeoutRef.current = null;
    }
    replyRef.current.set(
      runningId,
      (replyRef.current.get(runningId) ? `${replyRef.current.get(runningId)}\n` : '') + text,
    );
    bumpReplies((n) => n + 1);
    markTest.mutate({ id: runningId, result: 'unreviewed' });
    if (runAdvanceTimer.current) return; // already scheduled — keep gathering
    runAdvanceTimer.current = setTimeout(() => {
      runAdvanceTimer.current = null;
      advanceRun();
    }, 1500);
  };
  // "Running: safety #2" — category + its ordinal within the group.
  const runningLabel = (() => {
    if (!runningId) return null;
    const s = scenarios.find((x) => x.id === runningId);
    if (!s) return 'scenario';
    const sameCat = scenarios.filter((x) => x.category === s.category);
    return `${CAT_LABELS[s.category] ?? s.category} #${sameCat.indexOf(s) + 1}`;
  })();
  /** Match a reply's customer prompt back to its scenario — the docked
   *  panel renders the expectation + verdict buttons in place. */
  const verdictFor = (customerText?: string) => {
    if (!customerText) return null;
    const s = scenarios.find(
      (x) =>
        scenarioPrompt(x).trim().toLowerCase() === customerText.trim().toLowerCase(),
    );
    if (!s) return null;
    return {
      expectation: s.expectation,
      result: s.human_result,
      verdict: (r: 'pass' | 'fail') => markTest.mutate({ id: s.id, result: r }),
    };
  };
  const tryChips = (target: 'try' | 'dock') => {
    const list = scenarios.filter((s) => scenarioPrompt(s)).slice(0, 6);
    return (list.length > 0 || (builder?.suggested_questions?.length ?? 0) > 0) && (
      <div className="try-chips">
        <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>
          Try asking:
        </span>
        {list.length
          ? list.map((s) => {
              // Scenario chips run through the runner — the reply pairs,
              // the run is recorded, and the verdict shows on the chip.
              const state = s.stale
                ? 'stale'
                : s.human_result === 'pass'
                  ? 'pass'
                  : s.human_result === 'fail'
                    ? 'fail'
                    : '';
              const mark = s.stale ? '◷' : s.human_result === 'pass' ? '✓' : s.human_result === 'fail' ? '⚑' : null;
              return (
                <button
                  key={s.id}
                  className={`try-chip${state ? ` ${state}` : ''}`}
                  title={`${scenarioPrompt(s)}${
                    s.stale
                      ? ' — verdict stale, re-run'
                      : s.human_result === 'pass'
                        ? ' — looks right'
                        : s.human_result === 'fail'
                          ? ' — needs work'
                          : ''
                  }`}
                  onClick={() => runScenario(s)}
                >
                  {mark && <span className="try-chip-mark">{mark}</span>}
                  <span className="try-chip-text">{scenarioPrompt(s)}</span>
                </button>
              );
            })
          : (builder?.suggested_questions ?? []).map((q) => (
              <button
                key={q}
                className="try-chip"
                title={q}
                onClick={() => setSeed({ text: q, nonce: Date.now(), target })}
              >
                <span className="try-chip-text">{q}</span>
              </button>
            ))}
      </div>
    );
  };
  const correctCard = correctTarget && agent && (
    <CorrectThisCard
      agentId={agent.id}
      cfg={cfg}
      target={correctTarget}
      onClose={() => setCorrectTarget(null)}
      onSaved={(config) => {
        setCfg(config);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        markDrift();
      }}
      onSendToCopilot={(t) => railBus.copilotDraft(t)}
    />
  );
  // Customer region — optional; saved to builder.region on blur and
  // injected into the runtime prompt (hostedAgent), not the authored one.
  const [region, setRegion] = useState('');
  useEffect(() => {
    setRegion(agent?.config?.builder?.region ?? '');
  }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Find sources — Brave-gated source discovery. The API returns
  // configured:false when the agent hasn't connected its own Brave
  // integration; every candidate URL comes from the live response, so
  // nothing here can invent a link. Import is explicit, tagged to the
  // topic the user searched for.
  type Candidate = { title: string; url: string; domain: string; summary: string };
  const [findTopic, setFindTopic] = useState<Topic | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [findNote, setFindNote] = useState('');
  const findSources = useMutation({
    mutationFn: (t: Topic) => {
      const q = `${t.text}${builder?.region ? ` ${builder.region}` : ''}`;
      return api<{ configured: boolean; candidates: Candidate[] }>(
        `/api/agents/${agent?.id}/source-search`,
        { method: 'POST', body: JSON.stringify({ query: q }) },
      );
    },
    onMutate: (t) => {
      setFindTopic(t);
      setCandidates(null);
      setFindNote('');
    },
    onSuccess: (r, t) => {
      setFindTopic(t);
      setFindNote(r.configured ? '' : 'connect-brave');
      setCandidates(r.candidates);
      setPicked(new Set()); // nothing imports without explicit ticks
    },
    onError: (e) => {
      // Keep the card mounted so the failure is visible — clearing the
      // topic here would make a search error silent.
      setCandidates(null);
      setFindNote(e.message);
    },
  });
  const importSources = useMutation({
    mutationFn: async () => {
      if (!findTopic || !candidates) return 0;
      const chosen = candidates.filter((c) => picked.has(c.url));
      let added = 0;
      for (const cand of chosen) {
        await api(`/api/agents/${agent?.id}/knowledge-url`, {
          method: 'POST',
          body: JSON.stringify({
            url: cand.url,
            refresh_hours: 24,
            topic: findTopic.id,
          }),
        });
        added += 1;
      }
      return added;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['knowledge', agent?.id] });
      void qc.invalidateQueries({ queryKey: ['build-status', agent?.id] });
      setFindTopic(null);
      setCandidates(null);
      setPicked(new Set());
    },
    onError: (e) => setFindNote(e.message),
  });

  // Create is the brief — revisitable, but never a silent regeneration
  // source: editing it offers to review suggested changes, nothing more.
  const storedBrief = builder?.description ?? cfg.purpose ?? '';
  const [brief, setBrief] = useState('');
  const [briefChanged, setBriefChanged] = useState(false);
  useEffect(() => {
    // Seed from agent.config directly, not the `cfg` state — cfg is seeded
    // by its own effect and is still stale ({}) the render this runs in.
    const c = agent?.config;
    setBrief(c?.builder?.description ?? c?.purpose ?? '');
  }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const briefMutation = useMutation({
    mutationFn: () => {
      const config: AgentConfig = {
        ...cfg,
        purpose: brief.trim(),
        builder: { ...cfg.builder, description: brief.trim() },
      };
      return api(`/api/agents/${agent?.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ config }),
      }).then(() => config);
    },
    onSuccess: (config) => {
      const changed = brief.trim() !== storedBrief.trim();
      setCfg(config);
      setBriefChanged(changed);
      redraft.reset();
      applyDraft.reset();
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (e) => setError(e.message),
  });
  const redraft = useMutation({
    mutationFn: () =>
      api<{ draft: BuilderDraft | null }>(`/api/agents/${agent?.id}/redraft`, {
        method: 'POST',
        body: JSON.stringify({ description: brief.trim() }),
      }),
  });
  // Applying a re-draft adopts its authored fields (instructions, tone,
  // greeting) AND refreshes the stored suggestion lists — explicit, never
  // silent.
  const applyDraft = useMutation({
    mutationFn: (d: BuilderDraft) => {
      const config: AgentConfig = {
        ...cfg,
        ...(d.system_prompt ? { system_prompt: d.system_prompt } : {}),
        ...(d.tone ? { tone: d.tone } : {}),
        ...(d.greeting ? { greeting: d.greeting, greeting_enabled: true } : {}),
        builder: {
          ...cfg.builder,
          description: brief.trim(),
          ...(d.summary ? { summary: d.summary } : {}),
          // Apply replaces the suggestion SET, not just adds to it — a
          // draft that suggests nothing clears stale suggestions from the
          // old brief rather than leaving them orphaned on the grid.
          suggested_knowledge: d.suggested_knowledge ?? [],
          suggested_templates: d.suggested_templates ?? [],
          suggested_approvals: d.suggested_approvals ?? [],
          suggested_rules: d.suggested_rules ?? [],
          suggested_questions: d.suggested_questions ?? [],
          ...(d.knowledge_need ? { knowledge_need: d.knowledge_need } : {}),
          ...(d.knowledge_need_reason
            ? { knowledge_need_reason: d.knowledge_need_reason }
            : {}),
          // Replace semantics — a re-draft that now finds the domain isn't
          // location-dependent should hide the region field, not keep it.
          region_sensitive: d.region_sensitive === true,
          ...(d.domain_risk ? { domain_risk: d.domain_risk } : {}),
          // A re-draft that now says 'required' clears a stale skip — the
          // classification changed, hiding the step would bury a real need.
          ...(d.knowledge_need === 'required' ? { teach_skipped: false } : {}),
          generated_at: new Date().toISOString(),
        },
      };
      return api(`/api/agents/${agent?.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ config }),
      }).then(() => config);
    },
    onSuccess: (config) => {
      // Sync cfg immediately so "See what Janis created" re-renders with
      // the adopted draft — not just after the agents refetch lands.
      setCfg(config);
      setBriefChanged(false);
      redraft.reset();
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['build-status', agent?.id] });
    },
    onError: (e) => setError(e.message),
  });
  // Refresh-derived-suggestions — redrafts from the brief AND the current
  // instructions, and merges only the suggestion lists into config.builder.
  // The brief must stay in the source: drafted instructions are told not
  // to mention tools, so an instructions-only redraft forgets abilities
  // the user named outright ("share songs from iTunes") and the wholesale
  // replace would erase the suggestion. Instructions are included because
  // they may have been edited since create — suggestions should reflect
  // what the agent does now. Authored config (prompt/tone/greeting) is
  // never touched.
  const suggestAbilities = useMutation({
    mutationFn: async () => {
      const source = [storedBrief, cfg.system_prompt]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 4000);
      const r = await api<{ draft: BuilderDraft | null }>(
        `/api/agents/${agent?.id}/redraft`,
        { method: 'POST', body: JSON.stringify({ description: source }) },
      );
      const d = r.draft;
      if (!d) return { kind: 'failed' as const };
      // Replace the lists wholesale — a fresh draft with no templates
      // clears stale suggestions from an older brief, not just adds.
      const config: AgentConfig = {
        ...cfg,
        builder: {
          ...cfg.builder,
          suggested_knowledge: d.suggested_knowledge ?? [],
          suggested_templates: d.suggested_templates ?? [],
          suggested_approvals: d.suggested_approvals ?? [],
          suggested_rules: d.suggested_rules ?? [],
          suggested_questions: d.suggested_questions ?? [],
          ...(d.knowledge_need ? { knowledge_need: d.knowledge_need } : {}),
          ...(d.knowledge_need_reason
            ? { knowledge_need_reason: d.knowledge_need_reason }
            : {}),
          region_sensitive: d.region_sensitive === true,
          ...(d.knowledge_need === 'required' ? { teach_skipped: false } : {}),
          ...(d.domain_risk ? { domain_risk: d.domain_risk } : {}),
        },
      };
      await api(`/api/agents/${agent?.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ config }),
      });
      return {
        kind: d.suggested_templates?.length ? ('applied' as const) : ('empty' as const),
        config,
      };
    },
    onSuccess: (r) => {
      if (r.config) setCfg(r.config);
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['build-status', agent?.id] });
    },
    onError: (e) => setError(e.message),
  });

  return (
    <>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 className="page-title grow">
          {agent ? agent.name : 'New agent'}
        </h1>
      </div>

      {step !== 'start' && step !== 'bring' && (
      <>
      <div className="builder-steps">
        {STEPS.map((s, i) => {
          const locked = !agent && i > 0;
          // Marks carry meaning, not visited-ness: ✓ human confirmed or
          // acted, ◐ something exists but needs a look (Janis draft,
          // unreviewed suggestions, open gaps), ○ nothing yet. The
          // subtitle reports live state so the mark never needs a tooltip.
          const st = status?.steps[s.key];
          const g = status ? stepGlyph(s.key, st) : null;
          const done = st === 'done' || Boolean(agent && i < idx && !status);
          const subtitle = !status ? s.hint : stepSubtitle(s.key, status);
          return (
            <button
              key={s.key}
              className={`builder-step${step === s.key ? ' active' : ''}${g === 'check' || (done && !status) ? ' done' : ''}${g === 'half' ? ' partial' : ''}`}
              disabled={locked}
              title={
                locked
                  ? 'Create the agent first'
                  : // The full subtitle survives container-query truncation;
                    // Try it also names what's still unchecked or stale.
                    `${s.label} — ${subtitle}` +
                    (s.key === 'try' && status?.test_scenarios?.unchecked?.length
                      ? `\nUnchecked: ${status.test_scenarios.unchecked.join(', ')}`
                      : '')
              }
              onClick={() => goStep(s.key)}
            >
              <span className={`builder-step-n${g === 'check-muted' ? ' muted' : ''}`}>{
                g === 'check' || g === 'check-muted' ? '✓'
                : g === 'half' ? '◐'
                : '○'
              }</span>
              <span className="builder-step-label">{s.label}</span>
              <span className="builder-step-hint">{subtitle}</span>
            </button>
          );
        })}
      </div>
      {!legendSeen && (
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          ✓ confirmed by you · ◐ drafted — take a look · ○ nothing yet{' '}
          <button
            className="link small"
            onClick={() => {
              try { localStorage.setItem('janis.step-legend.v1', '1'); } catch { /* private mode */ }
              setLegendSeen(true);
            }}
          >
            dismiss
          </button>
        </div>
      )}
      </>
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
          <strong>{agent ? 'What you asked Janis to build' : 'Create your agent'}</strong>
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
                  'Describe the job you want your agent to do…\n\ne.g. "Answer ' +
                  'questions about my community garden — plot availability, ' +
                  'volunteer hours, and how to join — and point people at the ' +
                  'signup form when they\'re ready."'
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
              <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                This is the brief you gave Janis — it seeded the instructions,
                greeting, and suggestions below. Editing it won't rewrite your
                agent's setup: Janis will only offer suggested changes to
                review.
              </div>
              <textarea
                rows={5}
                style={{ width: '100%', marginTop: 12, boxSizing: 'border-box' }}
                placeholder="Describe the job you want your agent to do…"
                value={brief}
                disabled={!isAdmin}
                onChange={(e) => setBrief(e.target.value)}
              />
              <div className="row" style={{ marginTop: 10, gap: 8 }}>
                <button
                  className="btn"
                  disabled={
                    briefMutation.isPending || !isAdmin ||
                    brief.trim() === storedBrief.trim()
                  }
                  onClick={() => briefMutation.mutate()}
                >
                  {briefMutation.isPending ? 'Saving…' : 'Save brief'}
                </button>
                {next && (
                  <button className="btn primary" onClick={() => goStep(next.key)}>
                    {nextLabel} →
                  </button>
                )}
              </div>

              {/* Brief changed → offer review, never a silent rewrite. */}
              {briefChanged && !applyDraft.isSuccess && (
                <div className="card" style={{ marginTop: 12, borderColor: 'var(--accent-dim)' }}>
                  <strong>Your agent's brief has changed.</strong>
                  <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                    The instructions and training you've built weren't touched.
                    Janis can suggest updates that match the new brief — nothing
                    changes until you approve them.
                  </div>
                  <div className="row" style={{ marginTop: 10, gap: 8 }}>
                    <button
                      className="btn primary"
                      disabled={redraft.isPending}
                      onClick={() => redraft.mutate()}
                    >
                      {redraft.isPending ? 'Drafting…' : 'Review suggested changes'}
                    </button>
                    <button className="btn" onClick={() => setBriefChanged(false)}>
                      Keep existing setup
                    </button>
                  </div>
                  {redraft.data && !redraft.data.draft && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                      Couldn't generate suggestions right now — nothing was changed.
                    </div>
                  )}
                  {redraft.data?.draft && (
                    <div style={{ marginTop: 10 }}>
                      <div className="muted" style={{ fontSize: 12 }}>Suggested updates</div>
                      {redraft.data.draft.summary && (
                        <div style={{ fontSize: 13, marginTop: 6 }}>
                          <span className="muted">It would: </span>
                          {redraft.data.draft.summary[0].toUpperCase() +
                            redraft.data.draft.summary.slice(1)}
                        </div>
                      )}
                      {redraft.data.draft.system_prompt && (
                        <div style={{ marginTop: 8 }}>
                          <div className="muted" style={{ fontSize: 12 }}>Instructions</div>
                          <div
                            style={{
                              fontSize: 13,
                              marginTop: 2,
                              whiteSpace: 'pre-wrap',
                              maxHeight: 160,
                              overflow: 'auto',
                            }}
                          >
                            {redraft.data.draft.system_prompt}
                          </div>
                        </div>
                      )}
                      {redraft.data.draft.tone && (
                        <div style={{ marginTop: 8, fontSize: 13 }}>
                          <span className="muted">Tone: </span>
                          {redraft.data.draft.tone}
                        </div>
                      )}
                      {redraft.data.draft.suggested_knowledge?.length ? (
                        <div style={{ marginTop: 8, fontSize: 13 }}>
                          <span className="muted">New knowledge topics: </span>
                          {redraft.data.draft.suggested_knowledge
                            .slice(0, 6)
                            .map((t) => t.text)
                            .join(' · ')}
                        </div>
                      ) : null}
                      <div className="row" style={{ marginTop: 12, gap: 8 }}>
                        <button
                          className="btn primary"
                          disabled={applyDraft.isPending}
                          title="Adopt the new instructions, tone, and greeting, and refresh the suggestion lists"
                          onClick={() => applyDraft.mutate(redraft.data!.draft!)}
                        >
                          {applyDraft.isPending ? 'Applying…' : 'Apply suggested setup'}
                        </button>
                        <button className="btn" onClick={() => { redraft.reset(); }}>
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {applyDraft.isSuccess && (
                <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
                  Applied — the instructions, tone, and greeting now follow the
                  new brief. Review them in Guide it.
                </div>
              )}

              {builder?.summary && !briefChanged && (
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
                  {builder.suggested_knowledge
                    .slice(0, 5)
                    .map((t) => (typeof t === 'string' ? t : t.text))
                    .join(' · ')}
                </div>
              ) : null}
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
                {builder?.knowledge_need === 'unnecessary'
                  ? 'This domain is general knowledge — the model already answers it. Add a source only for facts it couldn\u2019t know, or skip this step.'
                  : 'Add trusted sources for the things your agent shouldn\u2019t guess at. Paste a link, upload a document, or write it in.'}
              </div>
              {(() => {
                const b = knowledgeData?.budget;
                if (!b || b.used_chars === 0) return null;
                const pct = Math.round((b.used_chars / b.limit) * 100);
                // Under ~25% the numbers are false precision — "33 tokens"
                // is noise next to the cap. Say enough and get out of the
                // way; the meter earns its detail as it fills. A notes cap
                // breach is a real warning though — never quiet that.
                if (pct < 25 && !(b.notes_chars > b.notes_limit))
                  return (
                    <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                      Knowledge budget — plenty of room.
                    </div>
                  );
                const tok =
                  b.used_chars >= 40_000
                    ? `${Math.round(b.used_chars / 4000)}k`
                    : Math.round(b.used_chars / 4).toLocaleString();
                return (
                  <div
                    className="muted"
                    style={{ fontSize: 12, marginTop: 8 }}
                  >
                    Knowledge: ~{tok} tokens · {pct}% of capacity
                    {b.notes_chars > b.notes_limit
                      ? ' — notes alone exceed their share; trim the Text tab'
                      : pct > 100
                        ? ` — over budget by ~${Math.round((b.used_chars - b.limit) / 4000)}k; on each reply, the least-relevant sources are left out`
                        : pct >= 60
                          ? ' — large knowledge sets can slow replies and make answers less focused'
                          : ''}
                  </div>
                );
              })()}
              {builder?.teach_skipped ? (
                <div className="card muted" style={{ marginTop: 10, fontSize: 13 }}>
                  Skipped — your agent answers without extra sources.{' '}
                  <button
                    className="link small"
                    disabled={confirmFlag.isPending}
                    onClick={() => confirmFlag.mutate({ teach_skipped: false })}
                  >
                    Mark as needed after all
                  </button>
                </div>
              ) : builder?.knowledge_need === 'required' && totalSources === 0 ? (
                <div
                  className="card"
                  style={{ marginTop: 10, borderColor: 'var(--warn, #f59e0b)' }}
                >
                  <strong>Your agent has no knowledge of your business yet.</strong>
                  <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                    Add at least one source before going live.
                  </div>
                </div>
              ) : builder?.knowledge_need === 'helpful' && totalSources === 0 ? (
                <div className="card muted" style={{ marginTop: 10, fontSize: 13 }}>
                  {builder.knowledge_need_reason
                    ? <>The model knows the broad strokes — {builder.knowledge_need_reason} </>
                    : 'The model already knows the broad strokes, but specifics vary — '}
                  adding a trusted source makes answers more reliable.
                </div>
              ) : builder?.knowledge_need === 'unnecessary' ? (
                <div className="card" style={{ marginTop: 10 }}>
                  <div className="muted" style={{ fontSize: 13 }}>
                    The model already knows this topic — add sources only for
                    things it couldn't know.
                  </div>
                  <button
                    className="btn sm"
                    style={{ marginTop: 8 }}
                    disabled={confirmFlag.isPending}
                    onClick={() => confirmFlag.mutate({ teach_skipped: true })}
                  >
                    Skip — it doesn't need extra knowledge
                  </button>
                </div>
              ) : null}
              {visibleTeachSubs.length > 1 && (
                <div className="tabs" style={{ marginTop: 12 }}>
                  {visibleTeachSubs.map((t) => (
                    <button
                      key={t.key}
                      className={`tab${teachSub === t.key ? ' active' : ''}`}
                      onClick={() => goTeachSub(t.key)}
                    >
                      {t.label}
                      {teachSubCount[t.key] > 0 ? ` · ${teachSubCount[t.key]}` : ''}
                    </button>
                  ))}
                </div>
              )}
              {/* Region matters only where answers vary by location — the
                  draft classifies it (region_sensitive); an agent with a
                  region already set keeps the field regardless. */}
              {rankedTopics.length && (builder?.region_sensitive || builder?.region) ? (
                <div style={{ marginTop: 12 }}>
                  <label
                    className="muted"
                    style={{ fontSize: 12 }}
                    htmlFor="teach-region"
                  >
                    Where will people be asking from? Schedules and
                    guidelines vary by region. (e.g. "UK", "Ontario, Canada")
                  </label>
                  <input
                    id="teach-region"
                    className="input"
                    style={{ width: 260, marginTop: 4 }}
                    placeholder="optional"
                    value={region}
                    disabled={!isAdmin || confirmFlag.isPending}
                    onChange={(e) => setRegion(e.target.value)}
                    onBlur={() => {
                      const v = region.trim();
                      if (v !== (builder?.region ?? '')) {
                        confirmFlag.mutate({ region: v });
                      }
                    }}
                  />
                </div>
              ) : null}
              {rankedTopics.length ? (
                <div className="card" style={{ marginTop: 12 }}>
                  <strong>Suggested topics</strong>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Your agent will answer these best with a source for each.
                  </div>
                  {visibleTopics.map((t) => {
                    const n = topicCounts.get(t.id) ?? 0;
                    const covered = n > 0 || coveredSet.has(t.id);
                    return (
                      <div
                        key={t.id}
                        className="row"
                        style={{ marginTop: 8, gap: 8, alignItems: 'baseline' }}
                      >
                        <span
                          className={`step-mark${covered ? ' done' : ''}`}
                          style={{ fontSize: 12 }}
                        >
                          {covered ? '✓' : '○'}
                        </span>
                        <span className="grow" style={{ fontSize: 13 }}>
                          {t.text}
                          {t.priority === 'high' && !covered ? (
                            <span className="muted" style={{ fontSize: 12 }}> — priority</span>
                          ) : null}
                          {covered ? (
                            <span className="muted" style={{ fontSize: 12 }}>
                              {' '}· Covered{n ? ` · ${n} source${n > 1 ? 's' : ''}` : ''}
                            </span>
                          ) : null}
                        </span>
                        {!covered && isAdmin ? (
                          <span style={{ whiteSpace: 'nowrap' }}>
                            <span className="src-menu-wrap">
                              <button
                                className="link small"
                                onClick={() =>
                                  setSrcMenuFor(srcMenuFor === t.id ? null : t.id)
                                }
                              >
                                Add source <ChevronDown size={11} style={{ verticalAlign: -1 }} />
                              </button>
                              {srcMenuFor === t.id ? (
                                <>
                                  <div
                                    className="menu-backdrop"
                                    onClick={() => setSrcMenuFor(null)}
                                  />
                                  <div className="menu-pop" role="menu">
                                    <button onClick={() => { setSrcMenuFor(null); pickTopic(t, 'url'); }}>
                                      Website
                                    </button>
                                    <button onClick={() => { setSrcMenuFor(null); pickTopic(t, 'file'); }}>
                                      File
                                    </button>
                                    <button onClick={() => { setSrcMenuFor(null); pickTopic(t, 'note'); }}>
                                      Note
                                    </button>
                                    <button
                                      disabled={findSources.isPending}
                                      onClick={() => { setSrcMenuFor(null); findSources.mutate(t); }}
                                    >
                                      {findSources.isPending && findTopic?.id === t.id
                                        ? 'Searching…'
                                        : 'Find sources'}
                                    </button>
                                  </div>
                                </>
                              ) : null}
                            </span>
                            <button
                              className="link small muted"
                              style={{ marginLeft: 10 }}
                              title="An existing source already covers this"
                              disabled={confirmFlag.isPending}
                              onClick={() => markCovered(t)}
                            >
                              Mark as covered
                            </button>
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                  {rankedTopics.length > 4 ? (
                    <button
                      className="link small"
                      style={{ marginTop: 8 }}
                      onClick={() => setShowAllTopics((v) => !v)}
                    >
                      {showAllTopics ? 'Show less' : `Show ${rankedTopics.length - 4} more`}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {findTopic ? (
                <div className="card" style={{ marginTop: 10 }}>
                  <strong>Source candidates — {findTopic.text}</strong>
                  {findNote === 'connect-brave' ? (
                    <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                      Janis can find sources for you once{' '}
                      <button className="link small" onClick={() => goStep('abilities')}>
                        Brave Search is connected
                      </button>{' '}
                      — it searches with your own Brave key, so connect it on
                      the Abilities step first.
                    </div>
                  ) : findSources.isPending ? (
                    <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                      Searching…
                    </div>
                  ) : candidates?.length ? (
                    <>
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        Tick the ones worth importing — check the domain; weak
                        sources are worse than none. Each page imports as its
                        own source, so you can deselect later; its real size
                        shows in the list once fetched.
                      </div>
                      {candidates.map((cand) => (
                        <label
                          key={cand.url}
                          className="row"
                          style={{
                            marginTop: 8,
                            gap: 8,
                            alignItems: 'baseline',
                            cursor: 'pointer',
                            fontSize: 13,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={picked.has(cand.url)}
                            onChange={(e) => {
                              const next = new Set(picked);
                              if (e.target.checked) next.add(cand.url);
                              else next.delete(cand.url);
                              setPicked(next);
                            }}
                          />
                          <span>
                            <strong>{cand.domain}</strong> — {cand.title}
                            <div className="muted" style={{ fontSize: 12 }}>{cand.summary}</div>
                          </span>
                        </label>
                      ))}
                      {findNote && findNote !== 'connect-brave' ? (
                        <div className="error" style={{ fontSize: 13, marginTop: 6 }}>{findNote}</div>
                      ) : null}
                      <div className="row" style={{ marginTop: 10, gap: 8 }}>
                        <button
                          className="btn sm primary"
                          disabled={!picked.size || importSources.isPending}
                          onClick={() => importSources.mutate()}
                        >
                          {importSources.isPending
                            ? 'Importing…'
                            : `Import ${picked.size} source${picked.size === 1 ? '' : 's'}`}
                        </button>
                        <button
                          className="btn sm"
                          onClick={() => {
                            setFindTopic(null);
                            setCandidates(null);
                            setPicked(new Set());
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                      No candidates found{findNote ? ` — ${findNote}` : ''}.
                    </div>
                  )}
                </div>
              ) : null}
              {teachSub === 'sources' && (
                <SourceList
                  agentId={agent.id}
                  agent={agent}
                  cfg={cfg}
                  isAdmin={isAdmin}
                  forTopic={activeTopic}
                  focusAdd={topicFocus}
                  onFocusConsumed={() => setTopicFocus(null)}
                  onTopicSettled={() => {
                    setActiveTopic(null);
                    setTopicFocus(null);
                  }}
                  onConfigSaved={(config) =>
                    api(`/api/agents/${agent.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ config }),
                    }).then(() => {
                      setCfg(config);
                      void qc.invalidateQueries({ queryKey: ['agents'] });
                    })
                  }
                  articlesExtras={
                    <label
                      className="row muted"
                      style={{ fontSize: 12, marginTop: 6, gap: 6, cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={!!builder?.include_drafts_in_test}
                        disabled={confirmFlag.isPending}
                        onChange={(e) =>
                          confirmFlag.mutate({ include_drafts_in_test: e.target.checked })
                        }
                      />
                      Include draft articles in test chats — production always
                      injects published only
                    </label>
                  }
                />
              )}
              {teachSub === 'gaps' && <KnowledgeGaps agentId={agent.id} config={cfg} />}
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
                boundaries, tone — e.g. "always be concise", "never quote a
                price that isn't in your knowledge", "ask for human approval
                before changing or cancelling an order". Janis drafted these
                from your description.
              </div>
              {builder?.domain_risk === 'elevated' && !builder?.guide_confirmed ? (
                <div
                  className="card"
                  style={{ marginTop: 10, borderColor: 'var(--warn, #f59e0b)' }}
                >
                  <div style={{ fontSize: 13 }}>
                    <strong>Elevated-risk domain.</strong>{' '}
                    <span className="muted">
                      Wrong answers here could hurt a person or animal, so Janis
                      drafted a safety stance and a human-escalation rule —
                      check they're right for your situation before confirming.
                    </span>
                  </div>
                </div>
              ) : null}
              {status?.steps.guide === 'partial' && !guideOpen ? (
                <div className="card" style={{ marginTop: 10 }}>
                  <strong>Janis drafted your instructions</strong>
                  <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                    Persona, rules, and greeting written from your brief
                    {cfg.system_prompt
                      ? ` — ~${Math.round(cfg.system_prompt.split(/\s+/).length)} words`
                      : ''}
                    . Review before the agent goes live; you can edit any of it.
                  </div>
                  <div className="row" style={{ marginTop: 8, gap: 8 }}>
                    <button className="btn sm" onClick={() => setGuideOpen(true)}>
                      Review draft
                    </button>
                    {isAdmin && (
                      <button
                        className="btn sm"
                        disabled={confirmFlag.isPending}
                        onClick={() => confirmFlag.mutate({ guide_confirmed: true })}
                      >
                        Looks good
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <InstructionsSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
                  {(builder?.instruction_edits?.length ?? 0) > 0 && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                      Janis improved the instructions after testing —{' '}
                      {builder!.instruction_edits!.length} rule
                      {builder!.instruction_edits!.length > 1 ? 's' : ''} added
                      from Correct this:
                      <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                        {builder!.instruction_edits!.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <GreetingSection cfg={cfg} setCfg={setCfg} isAdmin={isAdmin} />
                </>
              )}
              {isAdmin && (storedBrief || cfg.system_prompt) && (
                <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                  Changed what the agent does here?{' '}
                  <button
                    className="btn sm"
                    disabled={suggestAbilities.isPending}
                    onClick={() => suggestAbilities.mutate()}
                  >
                    {suggestAbilities.isPending
                      ? 'Refreshing…'
                      : 'Refresh suggested knowledge + abilities'}
                  </button>{' '}
                  so Teach it and Abilities match — the instructions above are
                  never touched.
                  {suggestAbilities.isSuccess &&
                    suggestAbilities.data?.kind === 'applied' &&
                    ' Suggestions updated.'}
                  {suggestAbilities.isSuccess &&
                    suggestAbilities.data?.kind === 'empty' &&
                    ' Nothing new to suggest.'}
                  {suggestAbilities.isSuccess &&
                    suggestAbilities.data?.kind === 'failed' &&
                    " Couldn't draft suggestions — try again in a moment."}
                </div>
              )}
              {isAdmin && status?.steps.guide === 'partial' && guideOpen && (
                <div className="row" style={{ marginTop: 10, gap: 8, alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Janis drafted this — happy with it?
                  </span>
                  <button
                    className="btn sm"
                    disabled={confirmFlag.isPending}
                    onClick={() => confirmFlag.mutate({ guide_confirmed: true })}
                  >
                    Looks good
                  </button>
                </div>
              )}
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
                    <span className="muted">
                      From your brief — these should wait for a human's sign-off
                      once an integration provides them:{' '}
                    </span>
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
              {!builder?.suggested_templates?.length && storedBrief && (
                <div className="card" style={{ marginTop: 12 }}>
                  <strong>No abilities suggested yet</strong>
                  <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                    Janis can read the brief and current instructions and flag
                    the integrations this agent probably needs — suggested ones
                    float to the top of the grid below.
                  </div>
                  <button
                    className="btn"
                    style={{ marginTop: 10 }}
                    disabled={suggestAbilities.isPending}
                    onClick={() => suggestAbilities.mutate()}
                  >
                    {suggestAbilities.isPending
                      ? 'Asking Janis…'
                      : 'Suggest abilities'}
                  </button>
                  {suggestAbilities.isSuccess &&
                    suggestAbilities.data?.kind === 'failed' && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                        Janis couldn't draft suggestions right now — try again in
                        a moment.
                      </div>
                    )}
                  {suggestAbilities.isSuccess &&
                    suggestAbilities.data?.kind === 'empty' && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                        Nothing in the catalog fits this brief — browse it below.
                      </div>
                    )}
                </div>
              )}
              <ToolsTab cfg={cfg} setCfg={setCfg} agentId={agent.id} isAdmin={isAdmin} />
              {isAdmin && status && status.steps.abilities !== 'done' && (
                <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                  This agent doesn&rsquo;t take actions?{' '}
                  <button
                    className="link small"
                    disabled={confirmFlag.isPending}
                    onClick={() => confirmFlag.mutate({ abilities_confirmed: true })}
                  >
                    Mark none needed
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {step === 'try' && agent && (
        <>
          {!hosted && <NotHosted />}
          {hosted && (
            <>
              <div className="row" style={{ marginTop: 12, alignItems: 'center', gap: 10 }}>
                <div className="muted grow" style={{ fontSize: 13 }}>
                  Deliberate checks, not a second chat — Run sends the prompt
                  into the test panel on the right, and you judge the reply.
                  This list becomes the agent's regression suite after launch.
                </div>
                <button
                  className="btn sm"
                  title="Start a fresh test conversation — earlier chats stay in the inbox"
                  onClick={() => {
                    newChat();
                    setDockOpen(true);
                  }}
                >
                  New chat
                </button>
                {scenarios.length > 0 && (
                  <button
                    className="btn sm"
                    title={
                      scenarios.some((s) => s.stale)
                        ? 'Config changed since some results — re-run the list'
                        : 'Run every scenario through the panel, one at a time'
                    }
                    onClick={runAll}
                  >
                    {scenarios.some((s) => s.stale) ? 'Run all again' : 'Run all'}
                  </button>
                )}
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
                      to={`/agents/new/${agent.id}?step=teach&sub=gaps`}>
                      all knowledge gaps
                    </Link>
                  </div>
                </div>
              )}
              {testNotice && (
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  {testNotice}
                </div>
              )}
              {scenarios.some((s) => s.stale) && (
                <div className="test-dock-notice" style={{ borderRadius: 8, marginTop: 10 }}>
                  Instructions, knowledge, or abilities changed since{' '}
                  {scenarios.filter((s) => s.stale).length} of these ran —{' '}
                  <button className="link small" onClick={runAll}>
                    run all again
                  </button>{' '}
                  before trusting them.
                </div>
              )}
              {testsQ.isPending && (
                <div className="muted" style={{ marginTop: 14 }}>Loading scenarios…</div>
              )}
              {testsQ.data && scenarios.length === 0 && (
                <div className="card" style={{ marginTop: 12 }}>
                  <strong>No scenarios yet</strong>
                  <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                    Chat in the test panel — every agent reply offers
                    "Save as test", and "Correct this → Add to tests" turns a
                    fix into a re-runnable check.
                  </div>
                </div>
              )}
              {CAT_ORDER.filter((cat) => scenarios.some((s) => s.category === cat)).map(
                (cat) => (
                  <div key={cat} style={{ marginTop: 16 }}>
                    <div className="scenario-cat">{CAT_LABELS[cat] ?? cat}</div>
                    {scenarios
                      .filter((s) => s.category === cat)
                      .map((s) => {
                        const prompt = scenarioPrompt(s);
                        const reply = replyRef.current.get(s.id);
                        const running = runningId === s.id;
                        return (
                          <div key={s.id} className="scenario-row">
                            <div className="grow" style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 13 }}>“{prompt}”</div>
                              {s.expectation && (
                                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                                  expected: {s.expectation}
                                </div>
                              )}
                              {s.category === 'actions' && (
                                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                                  runs the live pipeline — gated actions pause on an
                                  approval card, nothing executes silently
                                </div>
                              )}
                              {s.source === 'correction' && (
                                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                                  saved from a Correct this fix
                                </div>
                              )}
                            </div>
                            <div className="scenario-verdict">
                              {s.stale && (
                                <span className="scenario-badge stale" title="Config changed since this ran">
                                  stale
                                </span>
                              )}
                              {s.human_result === 'pass' && !s.stale && (
                                <span className="scenario-badge pass">looks right</span>
                              )}
                              {s.human_result === 'fail' && !s.stale && (
                                <span className="scenario-badge fail">needs work</span>
                              )}
                              {s.human_result === 'unreviewed' && !s.stale && (
                                <span className="scenario-badge">unreviewed</span>
                              )}
                            </div>
                            {reply && s.human_result === 'unreviewed' && (
                              <div className="row" style={{ gap: 6 }}>
                                <button
                                  className="btn sm primary"
                                  disabled={markTest.isPending}
                                  onClick={() =>
                                    markTest.mutate({ id: s.id, result: 'pass' })
                                  }
                                >
                                  Looks right
                                </button>
                                <button
                                  className="btn sm"
                                  disabled={markTest.isPending}
                                  onClick={() => {
                                    markTest.mutate({ id: s.id, result: 'fail' });
                                    setDockOpen(true);
                                    setCorrectTarget({ agentText: reply, customerText: prompt });
                                  }}
                                >
                                  Needs work
                                </button>
                              </div>
                            )}
                            {/* A failed run isn't the end — re-open the
                                correction card so "needs work" has a next
                                step, not just a badge. */}
                            {reply && s.human_result === 'fail' && (
                              <button
                                className="btn sm"
                                title="Open the fix path — knowledge gap or instruction rule"
                                onClick={() => {
                                  setDockOpen(true);
                                  setCorrectTarget({ agentText: reply, customerText: prompt });
                                }}
                              >
                                Fix it
                              </button>
                            )}
                            <button
                              className="btn sm"
                              disabled={running}
                              onClick={() => runScenario(s)}
                            >
                              {running ? 'Running…' : s.human_result ? 'Run again' : 'Run'}
                            </button>
                          </div>
                        );
                      })}
                  </div>
                ),
              )}
            </>
          )}
        </>
      )}

      {step === 'deploy' && agent && (
        <>
          {/* One intro line lives in AgentChannels — don't double it here. */}
          {hosted && status && (
            <div className="card readiness" style={{ marginTop: 8 }}>
              <strong className="readiness-title">Before you go live</strong>
              <ul className="readiness-list">
                {(() => {
                  const t = status.test_scenarios;
                  const kn = agent.config?.builder?.knowledge_need;
                  const hc = status.help_center;
                  const stepLink = (s: string) => `/agents/new/${agent.id}?step=${s}`;
                  const rows: { st: 'ok' | 'todo' | 'warn'; text: string; to: string }[] = [
                    {
                      st: status.steps.guide === 'done' ? 'ok' : 'todo',
                      text:
                        status.steps.guide === 'done'
                          ? 'Instructions reviewed'
                          : status.steps.guide === 'partial'
                            ? 'Instructions drafted — unreviewed'
                            : 'Instructions not written yet',
                      to: stepLink('guide'),
                    },
                    {
                      st: !t?.total
                        ? 'todo'
                        : t.failing || t.stale
                          ? 'warn'
                          : t.checked === t.total
                            ? 'ok'
                            : 'todo',
                      text: !t?.total
                        ? 'No test scenarios yet — add one in Try it'
                        : `Tests: ${t.checked} of ${t.total} scenario${t.total > 1 ? 's' : ''} checked${
                            t.failing
                              ? ` · ${t.failing} need${t.failing > 1 ? '' : 's'} work`
                              : ''
                          }${t.stale ? ` · ${t.stale} stale after a config change` : ''}`,
                      to: stepLink('try'),
                    },
                    {
                      st:
                        status.abilities > 0 || status.steps.abilities === 'na' ? 'ok' : 'todo',
                      text: status.abilities
                        ? `Abilities: ${status.abilities} tool${status.abilities > 1 ? 's' : ''}`
                        : status.steps.abilities === 'na'
                          ? 'Abilities: none needed'
                          : status.steps.abilities === 'partial'
                            ? 'Abilities: suggested — none connected'
                            : 'Abilities: none connected',
                      to: stepLink('abilities'),
                    },
                    {
                      st: status.knowledge.over_budget
                        ? 'warn'
                        : status.knowledge.sources > 0 || status.steps.teach === 'na'
                          ? 'ok'
                          : kn === 'required'
                            ? 'warn'
                            : 'todo',
                      text: status.knowledge.over_budget
                        ? 'Knowledge over the prompt budget — trim a source'
                        : status.knowledge.sources > 0
                          ? `Knowledge: ${status.knowledge.sources} source${status.knowledge.sources > 1 ? 's' : ''}`
                          : status.steps.teach === 'na'
                            ? status.teach_skipped
                              ? 'Knowledge: skipped'
                              : 'Knowledge: not needed for this topic'
                            : kn === 'required'
                              ? 'Knowledge: needed — nothing added'
                              : 'Knowledge: nothing added',
                      to: stepLink('teach'),
                    },
                  ];
                  // Elevated-risk agents keep the safety row visible even
                  // when everything else is green — it's the one row that
                  // shouldn't be skipped quietly.
                  if (status.domain_risk === 'elevated' || (t?.safety_total ?? 0) > 0) {
                    rows.push({
                      st:
                        t?.safety_total && t.safety_checked === t.safety_total
                          ? 'ok'
                          : 'warn',
                      text: t?.safety_total
                        ? `Safety: ${t.safety_checked} of ${t.safety_total} checked`
                        : 'Safety: no safety scenarios yet',
                      to: stepLink('try'),
                    });
                  }
                  if (hc && hc.total > 0 && hc.published === 0) {
                    rows.push({
                      st: 'warn',
                      text: `Help center: ${hc.total} article${hc.total > 1 ? 's' : ''} — none published`,
                      to: stepLink('teach'),
                    });
                  }
                  return rows.map((r, i) => (
                    <li key={i} className={`readiness-row ${r.st}`}>
                      <Link to={r.to} className="readiness-link">
                        <span className="readiness-mark" aria-hidden>
                          {r.st === 'ok' ? '✓' : r.st === 'warn' ? '⚠' : '○'}
                        </span>
                        {r.text}
                      </Link>
                    </li>
                  ));
                })()}
              </ul>
              <div className="muted" style={{ fontSize: 12 }}>
                Informational, never blocking — connect whenever you're ready.
              </div>
            </div>
          )}
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
        <div className="row" style={{ marginTop: 14, gap: 8, alignItems: 'center' }}>
          <button
            className="btn primary"
            disabled={saveCfg.isPending || !isAdmin}
            onClick={() => saveCfg.mutate()}
          >
            {saveCfg.isPending ? 'Saving…' : 'Save configuration'}
          </button>
          {hosted && (
            <button
              className="btn"
              disabled={saveCfg.isPending || !isAdmin}
              title="Save, then open the test chat — so you're never testing the unsaved version"
              onClick={() =>
                saveCfg.mutate(undefined, {
                  onSuccess: () => {
                    setDockOpen(true);
                    setChatFocus(Date.now());
                  },
                })
              }
            >
              Save &amp; test
            </button>
          )}
          {next && (
            <button
              className="btn"
              disabled={saveCfg.isPending}
              title="Saves this page first, then moves on"
              onClick={() =>
                saveCfg.mutate(undefined, { onSuccess: () => goStep(next.key) })
              }
            >
              {nextLabel} →
            </button>
          )}
          {step === 'teach' && totalSources === 0 && !builder?.teach_skipped ? (
            <span className="muted" style={{ fontSize: 12 }}>Knowledge still empty</span>
          ) : null}
        </div>
      )}
      {agent && hosted && (step === 'abilities' || step === 'try') && next && (
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => goStep(next.key)}>
            {nextLabel} →
          </button>
        </div>
      )}
      {agent && !hosted && step !== 'create' && next && (
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => goStep(next.key)}>{nextLabel} →</button>
        </div>
      )}
      {/* Test-tab content — portaled into the shared dock's slot. The
          strip, tabs, dim and push/overlay behavior all live in Layout;
          this page provides the wired panel: status, scenario hooks,
          corrections, chips. */}
      {dockAvailable && dock?.testSlot &&
        createPortal(
          <>
            <div
              className="test-dock-status"
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <span
                className="badge"
                title={`Private channel, same pipeline as production${builder?.include_drafts_in_test ? ' — includes drafts' : ''}`}
              >
                TEST
              </span>
              <span>
                Testing saved version
                {builder?.include_drafts_in_test ? ' + drafts' : ''}
                {runningLabel ? ` · running: ${runningLabel}` : ''}
              </span>
              <span className="grow" />
              <button
                className="link small"
                title="Start a fresh test conversation — earlier chats stay in the inbox"
                onClick={newChat}
              >
                New chat
              </button>
            </div>
            {copilotHint && (
              <div className="test-dock-notice">
                That sounds like a setup change — Copilot can change the
                agent directly.{' '}
                <button
                  className="link small"
                  onClick={() => {
                    railBus.copilotDraft(copilotHint);
                    setCopilotHint(null);
                  }}
                >
                  Send to Copilot
                </button>{' '}
                <button className="link small" onClick={() => setCopilotHint(null)}>
                  dismiss
                </button>
              </div>
            )}
            {cfgDrifted && (
              <div className="test-dock-notice">
                Config changed since this chat started — replies may mix old
                and new behavior.{' '}
                <button className="link small" onClick={newChat}>
                  Start new chat
                </button>
              </div>
            )}
            {tryChips('dock')}
            {testChannel.isPending && (
              <div className="muted" style={{ padding: 14 }}>Opening test channel…</div>
            )}
            {testChannel.isError && (
              <div className="error" style={{ margin: 14 }}>
                {(testChannel.error as Error).message}
              </div>
            )}
            {testChannel.data && (
              <AskJanis
                key={chatVisitor ?? 'base'}
                visitorOverride={chatVisitor ?? undefined}
                channelId={testChannel.data.channel_id}
                asCustomer
                hideHeader
                placeholder="You're chatting as a customer…"
                focusSignal={chatFocus}
                onCustomerMessage={(t) => {
                  setChatActive(true);
                  if (CONFIG_HINT_RE.test(t)) setCopilotHint(t);
                }}
                onCorrect={(ctx) => {
                  setCorrectTarget(ctx);
                }}
                onAgentReply={onAgentReply}
                verdictFor={verdictFor}
                onSaveTest={(ctx) => {
                  // A reply to a checklist prompt IS that scenario —
                  // saving it again would duplicate the row.
                  if (
                    ctx.customerText &&
                    scenarios.some(
                      (s) =>
                        scenarioPrompt(s).trim().toLowerCase() ===
                        ctx.customerText!.trim().toLowerCase(),
                    )
                  ) {
                    setTestNotice('That prompt is already a scenario');
                    return;
                  }
                  saveTest.mutate(ctx);
                }}
                seedMessage={seed?.target === 'dock' ? seed.text : undefined}
                seedNonce={seed?.nonce}
              />
            )}
            {correctCard}
          </>,
          dock.testSlot,
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
