import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '@janis/shared';
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAgents, useBuildStatus, useMe } from '../api/hooks';
import { useStream, type StreamAlert } from '../lib/useStream';
import { clearLastAgent, janisBrain, useContextAgent } from '../lib/agentContext';
import { trackOnce } from '../lib/analytics';
import { playAlertSound } from '../lib/alertSound';
import { setTabBadge } from '../lib/tabBadge';
import PushBanner from './PushBanner';
import { BrandImg } from './bits';
import { AskJanis } from './AskJanis';
import { CopilotHistory } from './CopilotHistory';
import { CorrectThisCard, type CorrectTarget } from './CorrectThis';
import { TestChatHistory } from './TestChatHistory';
import { type ScenarioTest, type ScenarioTurn } from './ScenarioRow';
import { useScenarioMatch } from '../lib/scenarioMatch';
import { revealScenario } from '../lib/scenarioRing';
import { freshTestVisitor, readTestVisitor, storeTestVisitor } from '../lib/testChat';
import { freshCopilotThread, readCopilotThread, storeCopilotThread } from '../lib/copilotThread';
import { railBus, type RailRequest } from '../lib/railBus';
import { DockContext, type DockTab, type TestWiring } from '../lib/dockContext';
import { markStepSeen, stepGlyph, stepSubtitle } from '../lib/seenSteps';
import {
  BarChart3, BookOpen, Bot, Bug, Building2, Check, ChevronRight, ChevronsUpDown,
  Columns2, Compass, CreditCard, FlaskConical, Gauge, Inbox, Maximize2, Megaphone,
  MessageSquarePlus, Minimize2, PenLine, Rocket, Settings, Sparkles, Users, Wrench,
  X, Zap,
} from 'lucide-react';
import { usePrompt } from './Prompt';
import { CommandPalette } from './CommandPalette';

interface Toast {
  id: string;
  title: string;
  body: string;
  url: string;
}

const ALERT_LABELS: Record<string, string> = {
  failure: 'Agent failure',
  help_request: 'Handoff requested',
  handoff_offer: 'Agent offered a human',
  custom: 'Alert',
  inactivity: 'Inactive conversation',
  keyword: 'Keyword match',
  sla: 'SLA breach — still unclaimed',
  approval_request: 'Approval requested',
  sentiment: 'Negative sentiment',
  intent: 'Topic match',
  error: 'Agent run error',
  csat: 'Low satisfaction score',
};

/** The six-step build sequence, also the persistent nav into each surface.
 *  create's SECTION_TO_STEP is a non-path so it never falsely lights on a
 *  section URL — its own link target is the builder route. */
type BuildStepKey = 'create' | 'teach' | 'guide' | 'abilities' | 'try' | 'deploy';
const BUILD_STEP_ORDER: BuildStepKey[] = ['create', 'teach', 'guide', 'abilities', 'try', 'deploy'];
const SECTION_TO_STEP: Record<BuildStepKey, string> = {
  create: '∅',
  teach: 'knowledge',
  guide: 'behavior',
  abilities: 'integrations',
  try: 'tests',
  deploy: 'channels',
};

/** Post-launch nav vocabulary — the same capabilities as the setup
 *  steps, but named for what an owner does day to day and linked to the
 *  persistent section surfaces rather than the guided builder. 'Create'
 *  has no live counterpart: editing the brief stays in the guided view
 *  (reopened from Overview) and agent details live under settings. */
const LIVE_NAV: Record<Exclude<BuildStepKey, 'create'>, { label: string; section: string }> = {
  teach: { label: 'Knowledge', section: 'knowledge' },
  guide: { label: 'Behavior', section: 'behavior' },
  abilities: { label: 'Actions', section: 'integrations' },
  try: { label: 'Test', section: 'tests' },
  deploy: { label: 'Channels', section: 'channels' },
};

/** Sidebar agent nav — setup mode shows the six guided steps, each
 *  opening its builder stage; once a channel is live the same items
 *  become the persistent section surfaces with day-to-day names.
 *  External-webhook agents only have a channels surface either way. */
function buildNav(agent: Agent, agentId: string, live: boolean) {
  const steps: {
    key: BuildStepKey;
    label: string;
    to: string;
    Icon: typeof BookOpen;
  }[] = [
    { key: 'create', label: 'Create', to: `/agents/new/${agentId}?step=create`, Icon: PenLine },
    { key: 'teach', label: 'Teach it', to: `/agents/new/${agentId}?step=teach`, Icon: BookOpen },
    { key: 'guide', label: 'Guide it', to: `/agents/new/${agentId}?step=guide`, Icon: Compass },
    { key: 'abilities', label: 'Abilities', to: `/agents/new/${agentId}?step=abilities`, Icon: Zap },
    { key: 'try', label: 'Try it', to: `/agents/new/${agentId}?step=try`, Icon: FlaskConical },
    { key: 'deploy', label: 'Deploy', to: `/agents/new/${agentId}?step=deploy`, Icon: Rocket },
  ];
  if (janisBrain(agent)) {
    if (!live) return steps;
    return steps
      .filter((s) => s.key !== 'create')
      .map((s) => ({ ...s, label: LIVE_NAV[s.key as keyof typeof LIVE_NAV].label, to: `/agents/${agentId}/${LIVE_NAV[s.key as keyof typeof LIVE_NAV].section}` }));
  }
  return [{ key: 'deploy' as const, label: live ? 'Channels' : 'Deploy', to: `/agents/${agentId}/channels`, Icon: Rocket }];
}

interface MeData {
  workspace: { id: string; name: string } | null;
  workspaces: { id: string; name: string; role: string }[];
  invites: { id: string; workspace_name: string }[];
  agent_invites: { workspace_id: string; workspace_name: string; agents: string[] }[];
}

/** Top-left context switcher: the workspace block on top (usage, settings,
 *  switch/create/join), the workspace's agents below. Selecting the
 *  workspace header switches the whole app to workspace context; picking an
 *  agent switches to that agent's context. */
function ContextSwitcher({
  data,
  agents,
  currentAgentId,
  planName,
  onGo,
  onSwitchWorkspace,
  onCreateWorkspace,
  onAnswerInvite,
  onAddAgent,
}: {
  data: MeData | undefined;
  agents: { id: string; name: string }[];
  currentAgentId: string | undefined;
  planName: string | undefined;
  onGo: (path: string) => void;
  onSwitchWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
  onAnswerInvite: (id: string, action: 'accept' | 'decline') => void;
  onAddAgent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [wsList, setWsList] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // The popover is position:fixed — the sidebar's overflow-y:auto would clip
  // an absolutely-positioned menu, and .main paints after the sidebar in DOM
  // order. Fixed escapes both; anchored to the button's rect on open.
  const [popPos, setPopPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPopPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen((o) => !o);
  };
  const go = (path: string) => {
    setOpen(false);
    onGo(path);
  };
  const ws = data?.workspace;
  const currentAgent = agents.find((a) => a.id === currentAgentId);
  const initial = (currentAgent?.name ?? ws?.name ?? '?').slice(0, 1).toUpperCase();
  return (
    <div className="ctx-switch" ref={ref}>
      <button
        type="button"
        ref={btnRef}
        className="ctx-btn"
        aria-expanded={open}
        aria-label="Switch workspace or agent"
        onClick={toggle}
      >
        <span className="ctx-avatar">{initial}</span>
        <span className="ctx-stack">
          <span className="ctx-top">{ws?.name ?? 'No workspace'}</span>
          <span className="ctx-cur">{currentAgent?.name ?? 'Workspace'}</span>
        </span>
        <ChevronsUpDown size={14} className="icon" />
      </button>
      {open && (
        <div className="ctx-pop" role="menu" style={{ top: popPos.top, left: popPos.left }}>
          {ws && (
            <>
              <button
                type="button"
                className="ctx-item ctx-ws"
                onClick={() => go('/conversations')}
              >
                <span className="ctx-avatar">{(ws.name || '?').slice(0, 1).toUpperCase()}</span>
                <span className="grow ctx-ws-name">{ws.name}</span>
                {planName && <span className="ctx-plan">{planName}</span>}
                {!currentAgentId && <Check size={14} />}
              </button>
              <button
                type="button"
                className="ctx-item ctx-sub"
                aria-expanded={wsList}
                onClick={() => setWsList((o) => !o)}
              >
                <span className="grow">Switch workspace</span>
                <ChevronRight size={14} className={wsList ? 'ctx-open' : ''} />
              </button>
              {wsList && (
                <div className="ctx-sublist">
                  {data!.workspaces
                    .filter((w) => w.id !== ws.id)
                    .map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        className="ctx-item"
                        onClick={() => onSwitchWorkspace(w.id)}
                      >
                        <Building2 size={13} className="ctx-ic" />
                        <span className="grow">{w.name}</span>
                      </button>
                    ))}
                  {data!.agent_invites.map((ai) => (
                    <button
                      key={ai.workspace_id}
                      type="button"
                      className="ctx-item"
                      onClick={() => onSwitchWorkspace(ai.workspace_id)}
                    >
                      <Building2 size={13} className="ctx-ic" />
                      <span className="grow">{ai.workspace_name} · agent access</span>
                    </button>
                  ))}
                  {data!.invites.length > 0 && <div className="ctx-sep" />}
                  {data!.invites.map((inv) => (
                    <div key={inv.id} className="ctx-invite">
                      <div className="ctx-invite-msg">
                        <Building2 size={13} className="ctx-ic" />
                        <span>Invited to {inv.workspace_name}</span>
                      </div>
                      <div className="row" style={{ gap: 6, marginTop: 6 }}>
                        <button type="button" className="btn sm grow" onClick={() => onAnswerInvite(inv.id, 'accept')}>
                          Join
                        </button>
                        <button type="button" className="btn sm grow" onClick={() => onAnswerInvite(inv.id, 'decline')}>
                          Decline
                        </button>
                      </div>
                    </div>
                  ))}
                  <button type="button" className="ctx-item" onClick={onCreateWorkspace}>
                    ＋ Create workspace
                  </button>
                </div>
              )}
              <div className="ctx-sep" />
            </>
          )}
          <div className="ctx-label">Agents</div>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              className="ctx-item"
              onClick={() => go(`/agents/${a.id}`)}
            >
              <Bot size={13} className="ctx-ic" />
              <span className="grow">{a.name}</span>
              {a.id === currentAgentId && <Check size={14} />}
            </button>
          ))}
          <button type="button" className="ctx-item" onClick={onAddAgent}>
            ＋ Add agent
          </button>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { data } = useMe();
  // GA4 sign_up — fires once per account, only for users created in the last
  // day (created_at on /me), so returning users on fresh browsers don't
  // re-count as signups.
  useEffect(() => {
    const createdAt = data?.user?.created_at;
    if (!createdAt) return;
    const ageMs = Date.now() - new Date(createdAt).getTime();
    if (ageMs >= 0 && ageMs < 24 * 3600_000) {
      trackOnce(`sign_up:${data!.user.id}`, 'sign_up');
    }
  }, [data?.user?.created_at, data?.user?.id]);
  // The right dock is one slot with tabs: Copilot (the concierge) and the
  // agent's test chat. Both stay mounted while the dock is open — the
  // inactive pane is hidden so scroll position and drafts survive switches.
  // Layout owns the strip/panel chrome; a page (the builder) can portal a
  // fully-wired test panel into the Test slot, else a plain chat renders.
  const [railOpen, setRailOpen] = useState(false);
  const [railTab, setRailTab] = useState<'ask' | 'test'>('ask');
  const [testRail, setTestRail] = useState<RailRequest | null>(null);
  const [askSeed, setAskSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [copilotDraft, setCopilotDraft] = useState<{ text: string; nonce: number } | null>(null);
  // Which concierge thread the copilot rail shows — null = the default
  // shared thread; a t<rand> key scopes to its own conversation (server
  // forks the u: participant). Persists across reloads like testVisitor.
  const [askThread, setAskThreadState] = useState<string | null>(() => readCopilotThread());
  const setAskThread = (t: string | null) => {
    setAskThreadState(t);
    storeCopilotThread(t);
    // A pending seed/draft belongs to the thread it was fired into —
    // don't let the remount replay it here.
    setAskSeed(null);
    setCopilotDraft(null);
  };
  const [testSeed, setTestSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [fallbackSeed, setFallbackSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [testSlot, setTestSlot] = useState<HTMLElement | null>(null);
  const [testProvided, setTestProvided] = useState(false);
  // ONE mounted test chat lives here — pages swap its wiring via
  // setTestWiring instead of mounting their own AskJanis, so builder →
  // Inbox navigation never remounts (and refetches) the conversation.
  const [testWiring, setTestWiring] = useState<TestWiring | null>(null);
  // Per-agent channel ids survive provider handoffs: the builder's resolved
  // test channel stays cached so the chat's `key` doesn't change while the
  // fallback's lazy resolution catches up.
  const testChannelIds = useRef<Record<string, string>>({});
  // Which test conversation the shared chat is keyed to, plus the
  // fallback's notice/correction state — the Try-it affordances used when
  // no page supplies wiring.
  const [testVisitor, setTestVisitor] = useState<string | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState('');
  const [fallbackCorrect, setFallbackCorrect] = useState<CorrectTarget | null>(null);
  const [dockCallout, setDockCallout] = useState(false);
  // A Copilot reply while its pane isn't visible lights the strip icon and
  // header tab — cleared the moment the copilot surface is showing.
  const [copilotUnread, setCopilotUnread] = useState(false);
  const [dockExpanded, setDockExpanded] = useState(false);
  const [dockSplit, setDockSplit] = useState(() => {
    try { return localStorage.getItem('janis.dock-split') === '1'; } catch { return false; }
  });
  // Below the push breakpoint the dock is a drawer — two columns or an
  // 840px panel can't fit. CSS already hides the split toggle under
  // 1800px but never unlatches a split latched wide; this does, settling
  // on Copilot (the pane that still works cramped). The split pref is
  // left alone — widening the window restores it.
  const [narrowWin, setNarrowWin] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 1200,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1199px)');
    const on = (e: MediaQueryListEvent) => {
      setNarrowWin(e.matches);
      if (e.matches) {
        if (dockSplit) setRailTab('ask');
        setDockExpanded(false);
      }
    };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [dockSplit]);
  useEffect(
    () =>
      railBus.subscribe((r) => {
        if (r.draft) {
          setCopilotDraft({ text: r.draft, nonce: Date.now() });
          setRailTab('ask');
        } else if (r.seed) {
          setAskSeed({ text: r.seed, nonce: Date.now() });
          setRailTab('ask');
        } else {
          setTestRail(r);
          setRailTab('test');
          if (r.q) setTestSeed({ text: r.q, nonce: Date.now() });
        }
        setRailOpen(true);
      }),
    [],
  );
  const hasAsk = Boolean(data?.support_channel_id);

  // Agent context: explicit on /agents/:id/* URLs, persisted elsewhere so
  // the shared pages keep defaulting to the selected agent. The sidebar's
  // agent subsection, the concierge rail and the inbox badge all key off it.
  const ctxAgent = useContextAgent();
  const { data: agentsData } = useAgents();
  const currentAgent = agentsData?.agents.find((a) => a.id === ctxAgent);
  // Build status drives both the nav marks and the setup→live switch:
  // the first live channel turns the guided steps into their section
  // surfaces (same model the builder rail and Overview read).
  const { data: agentStatus } = useBuildStatus(ctxAgent ?? undefined);
  const agentLive = agentStatus?.steps.deploy === 'done';

  // /ask — the concierge rail as a full page. The same mounted rail fills the
  // content column so drafts/scroll survive expand ↔ dock round-trips.
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isAskPage = location.pathname === '/ask';
  // A shared page's scoped URL is still that page — /agents/:id/inbox lights
  // Inbox, not Agents (Agents itself is `end`-matched, list page only).
  const scopedActive =
    (name: string) =>
    ({ isActive }: { isActive: boolean }) =>
      isActive || new RegExp(`^/agents/[^/]+/${name}(/|$)`).test(location.pathname)
        ? 'active'
        : '';
  const lastNonAsk = useRef('/conversations');
  useEffect(() => {
    if (!isAskPage) lastNonAsk.current = location.pathname + location.search;
  }, [location.pathname, location.search, isAskPage]);

  // ── Unified dock ──────────────────────────────────────────────────────
  // Tabs are scoped by location: agent pages offer Test (a hosted agent to
  // exercise) alongside Copilot; workspace pages offer Copilot only. The
  // builder signals it's portaling a wired panel via setTestProvided, which
  // itself proves a testable agent is in context.
  const testAvail =
    testProvided ||
    Boolean(currentAgent && janisBrain(currentAgent)) ||
    Boolean(testRail && (!ctxAgent || testRail.agentId === ctxAgent));
  const bothTabs = hasAsk && testAvail;
  const dockScope = ctxAgent ?? 'ws';
  const onBuilderPage = /^\/agents\/new\//.test(location.pathname);

  // Per-scope memory: the last tab survives navigation. Open/closed is ONE
  // dock state — an agent switch keeps whatever it was, so it's only
  // restored on a fresh page load. A ?rail= deeplink wins over saved state.
  const restoredFor = useRef('');
  useEffect(() => {
    if (data === undefined || restoredFor.current === dockScope) return;
    const freshLoad = restoredFor.current === '';
    restoredFor.current = dockScope;
    if (searchParams.get('rail')) return;
    try {
      const t = localStorage.getItem(`janis.dock-tab.${dockScope}`);
      if (t === 'test' && testAvail) setRailTab('test');
      else if (t === 'copilot') setRailTab('ask');
      if (freshLoad) {
        // Pre-global builds remembered open per scope — honor it once.
        const o =
          localStorage.getItem('janis.dock-open') ??
          localStorage.getItem(`janis.dock-open.${dockScope}`);
        if (o === 'open' && (hasAsk || testAvail)) setRailOpen(true);
      }
    } catch {
      /* private mode */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockScope, data, testAvail, hasAsk]);
  useEffect(() => {
    // Before /me lands the real rail state is unknown — writing here would
    // clobber the saved state with the mount-time defaults every reload.
    if (data === undefined) return;
    try {
      localStorage.setItem(`janis.dock-tab.${dockScope}`, railTab === 'ask' ? 'copilot' : 'test');
      localStorage.setItem('janis.dock-open', railOpen ? 'open' : 'closed');
    } catch {
      /* private mode */
    }
  }, [railTab, railOpen, dockScope, data]);

  // First encounter with a testable agent on the builder — the dock opens
  // once on wide screens, or the strip earns a callout on narrow ones.
  // After that the saved open/closed choice rules.
  useEffect(() => {
    if (!onBuilderPage || !testAvail || !ctxAgent) return;
    const k = `janis.dock-intro.${ctxAgent}`;
    try {
      if (localStorage.getItem(k)) return;
      localStorage.setItem(k, '1');
    } catch {
      /* private mode */
    }
    if (window.innerWidth >= 1440) {
      setRailTab('test');
      setRailOpen(true);
    } else {
      setDockCallout(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onBuilderPage, testAvail, ctxAgent]);

  // Test-tab fallback — a plain chat when no page is portaling a wired
  // panel (agent pages other than the builder). Resolves the test channel
  // lazily; on builder pages the builder's own panel owns the slot.
  // The agent the shared test chat serves — the builder's agent wins while
  // it provides wiring (its testRail may be stale from another agent).
  const chatAgentId =
    testProvided && ctxAgent ? ctxAgent : testRail?.agentId ?? ctxAgent;
  // The provider's wiring is only trusted while it names the same agent —
  // on a builder → other-agent navigation there's a commit where ctxAgent
  // has flipped but the old page's cleanup hasn't cleared its wiring yet;
  // reading it would stamp the old agent's channel into the new agent's
  // cache slot and render the old agent's chat under the new agent's name.
  const wiring =
    testProvided && testWiring?.agentId === chatAgentId ? testWiring : null;
  // Channel resolution: the provider's resolved channel, else the rail's,
  // else the per-agent cache populated by either — the cache is what makes
  // the builder → agent-page handoff a prop swap instead of a remount.
  // Live sources are read at RENDER time: a cache-only read misses the same
  // commit that delivers the channel (the ref write below can't re-render),
  // leaving an empty dock until an unrelated render happens along.
  const liveChannelId =
    wiring?.channelId ??
    (testRail && testRail.agentId === chatAgentId ? testRail.channelId : undefined);
  useEffect(() => {
    if (chatAgentId && liveChannelId) testChannelIds.current[chatAgentId] = liveChannelId;
  }, [chatAgentId, liveChannelId]);
  const chatChannelId = chatAgentId
    ? (liveChannelId ?? testChannelIds.current[chatAgentId])
    : undefined;
  useEffect(() => {
    if (!(railOpen && railTab === 'test') || testProvided || onBuilderPage) return;
    if (!ctxAgent || !currentAgent || !janisBrain(currentAgent)) return;
    if (testChannelIds.current[ctxAgent] || testRail?.agentId === ctxAgent) return;
    void api<{ channel_id: string }>(`/api/agents/${ctxAgent}/test-channel`, { method: 'POST' })
      .then((r) => {
        testChannelIds.current[ctxAgent] = r.channel_id;
        setTestRail({ channelId: r.channel_id, label: currentAgent.name ?? '', agentId: ctxAgent });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railOpen, railTab, testProvided, onBuilderPage, ctxAgent, currentAgent]);

  // Agent switch retargets the shared test chat — a rail resolved for the
  // previous agent is stale and would keep chatAgentId pinned to it. The
  // lazy resolver above re-stamps it for the new context (the per-agent
  // channel cache makes it a prop swap, not a reload). An explicit
  // ?rail=test&agent=<id> request survives while context doesn't change.
  const prevCtxAgent = useRef(ctxAgent);
  useEffect(() => {
    if (prevCtxAgent.current === ctxAgent) return;
    prevCtxAgent.current = ctxAgent;
    if (testRail?.agentId !== ctxAgent) setTestRail(null);
    // A seed queued for the old agent isn't input for the new one's chat.
    setTestSeed(null);
    setFallbackSeed(null);
  }, [ctxAgent, testRail]);

  // The shared chat keys to the same persisted visitor everywhere —
  // navigating builder → Inbox keeps the thread you were just on.
  useEffect(() => {
    setTestVisitor(chatAgentId ? readTestVisitor(chatAgentId) : null);
    setFallbackCorrect(null);
    // testProvided flip IS the handoff moment — the builder may have just
    // written a fresh visitor before unmounting, so re-read then too.
  }, [chatAgentId, testProvided]);
  const setChatVisitor = useCallback(
    (v: string) => {
      setTestVisitor(v);
      if (chatAgentId) storeTestVisitor(chatAgentId, v);
    },
    [chatAgentId],
  );

  // Try-it affordances for the fallback wiring — the same scenario
  // matching + verdict writes the builder registers on its pages.
  const fallbackActive =
    railOpen && railTab === 'test' && !testProvided && Boolean(chatAgentId);
  const fallbackTests = useQuery({
    queryKey: ['agent-tests', chatAgentId],
    queryFn: () =>
      api<{ tests: ScenarioTest[] }>(`/api/agents/${chatAgentId}/tests`),
    enabled: fallbackActive,
  });
  const fallbackScenarios = fallbackTests.data?.tests ?? [];
  // Meaning-based lookup — fuzzy locally, semantic via the server queue,
  // so a paraphrased or typo'd prompt still finds its scenario.
  const matchScenario = useScenarioMatch(chatAgentId ?? undefined, fallbackScenarios);
  const fallbackScenario = (customerText?: string, turns?: ScenarioTurn[]) =>
    matchScenario(customerText, turns);
  const fallbackVerdictFor = (
    customerText?: string,
    replyText?: string,
    turns?: ScenarioTurn[],
  ) => {
    const s = fallbackScenario(customerText, turns);
    if (!s || !chatAgentId) return null;
    return {
      scenarioId: s.id,
      expectation: s.expectation,
      result: s.human_result ?? null,
      verdict: (r: 'pass' | 'fail') => {
        void api(`/api/agents/${chatAgentId}/tests/${s.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ human_result: r }),
        }).then(() => {
          void qc.invalidateQueries({ queryKey: ['agent-tests', chatAgentId] });
          void qc.invalidateQueries({ queryKey: ['build-status', chatAgentId] });
        });
        if (r === 'fail' && replyText) {
          setFallbackCorrect({
            agentText: replyText,
            customerText,
            scenario: { id: s.id, expectation: s.expectation },
          });
        }
      },
    };
  };
  const fallbackOnCorrect = (ctx: {
    agentText: string;
    customerText?: string;
    turns?: ScenarioTurn[];
  }) => {
    const s = fallbackScenario(ctx.customerText, ctx.turns);
    setFallbackCorrect({
      agentText: ctx.agentText,
      customerText: ctx.customerText,
      turns: ctx.turns,
      ...(s ? { scenario: { id: s.id, expectation: s.expectation } } : {}),
    });
  };
  // "see matched scenario" off-builder — the regression rows live on the
  // agent's tests section, hash-anchored per row.
  const fallbackShowScenario = (id: string) => {
    if (!chatAgentId) return;
    navigate(`/agents/${chatAgentId}/tests#sc-${id}`);
    // Same-hash re-click: the destination's hash effect won't re-run,
    // so reveal now if the row is already mounted.
    revealScenario(id);
  };
  const fallbackOnSaveTest = (ctx: {
    agentText: string;
    customerText?: string;
    turns?: ScenarioTurn[];
  }) => {
    if (!ctx.customerText || !chatAgentId) return;
    if (fallbackScenario(ctx.customerText, ctx.turns)) {
      setFallbackNotice('That prompt is already a scenario');
      return;
    }
    void api(`/api/agents/${chatAgentId}/tests`, {
      method: 'POST',
      body: JSON.stringify({
        ...((ctx.turns?.length ?? 0) > 1
          ? { turns: ctx.turns, original_reply: ctx.agentText.slice(0, 4000) }
          : { prompt: ctx.customerText.slice(0, 400) }),
        expectation: ctx.agentText.slice(0, 600),
        category: 'general',
        source: 'user',
      }),
    })
      .then(() => {
        setFallbackNotice('Added to the scenario list');
        void qc.invalidateQueries({ queryKey: ['agent-tests', chatAgentId] });
      })
      .catch((e) => setFallbackNotice(e.message));
  };

  // A queued test seed goes to the portaled panel when a page provides one;
  // on other agent pages it seeds the fallback chat (cleared so a later
  // portaling page doesn't replay it).
  useEffect(() => {
    if (!testSeed || testProvided || !(railOpen && railTab === 'test')) return;
    setFallbackSeed(testSeed);
    setTestSeed(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testSeed, testProvided, railTab, railOpen]);

  const railVisible =
    (railOpen && ((railTab === 'ask' && hasAsk) || (railTab === 'test' && testAvail))) ||
    (isAskPage && hasAsk);
  // Split panes only off /ask — the expanded concierge page is Copilot alone.
  const splitActive = dockSplit && bothTabs && !isAskPage && !narrowWin;

  // The copilot surface is visible on /ask, or in the dock when the dock
  // is open on the ask tab (or split shows both). Anything arriving while
  // it's hidden counts as unread.
  useEffect(() => {
    if (isAskPage || (railOpen && (railTab === 'ask' || splitActive))) setCopilotUnread(false);
  }, [isAskPage, railOpen, railTab, splitActive]);

  // On /ask the rail must be open on the ask tab; a workspace with no
  // concierge has nothing to show there — bounce back to the last page.
  // ?q= deep-links a seeded question the same way ?rail=ask&q= did.
  useEffect(() => {
    if (!isAskPage) return;
    if (data && !hasAsk) {
      navigate(lastNonAsk.current, { replace: true });
      return;
    }
    setRailTab('ask');
    setRailOpen(true);
    const q = searchParams.get('q');
    if (q) {
      setAskSeed({ text: q, nonce: Date.now() });
      const p = new URLSearchParams(searchParams);
      p.delete('q');
      setSearchParams(p, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAskPage, hasAsk, data, searchParams]);

  // Overlay mode (under the push breakpoint) covers the page — a nav click
  // beneath it lands on an invisible page, and a user who clicks Next
  // shouldn't resurface behind a dock they forgot was open. Fold on any
  // real navigation (rail/agent params are the dock's own mirror — ignored).
  // Push mode (≥1200px) persists across steps, as specced. Declared before
  // the ?rail= consumer so a deeplinked dock still opens.
  const prevNav = useRef('');
  useEffect(() => {
    const p = new URLSearchParams(searchParams);
    p.delete('rail');
    p.delete('agent');
    const key = `${location.pathname}?${p.toString()}`;
    if (!prevNav.current || key === prevNav.current) {
      prevNav.current = key;
      return;
    }
    prevNav.current = key;
    if (window.matchMedia('(max-width: 1199px)').matches) setRailOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search]);

  // Overlay mode dismisses like a drawer — Escape too. Deliberate, so it
  // never surprises the persistent push-mode dock.
  useEffect(() => {
    if (!railOpen || isAskPage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && window.matchMedia('(max-width: 1199px)').matches)
        setRailOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [railOpen, isAskPage]);

  // Deeplinks: ?rail=ask | ?rail=test&agent=<id> — merged into the existing
  // params so page params like ?tab= survive. Consumed once per combo.
  const railParam = searchParams.get('rail');
  const railAgentParam = searchParams.get('agent');
  const consumedRail = useRef('');
  const navType = useNavigationType();
  useEffect(() => {
    // The rail's own ?rail= URL mirror navigates with replace — that's not a
    // deeplink. Without this guard a stamped param survives into the next
    // location and the consumer re-opens the rail a nav click just closed.
    if (navType === 'REPLACE') return;
    // On /ask the path is the state — a stray ?rail= param must not pop a
    // docked rail over the expanded page.
    if (isAskPage) return;
    const key = `${railParam}:${railAgentParam}`;
    if (key === consumedRail.current) return;
    if (railParam === 'ask') {
      // Bare ?rail=ask is the docked state the URL mirror stamps — restore it
      // as a docked rail so a refresh keeps the page underneath. Only a
      // seeded question (?q=) upgrades to the /ask page.
      const q = searchParams.get('q');
      if (q) {
        consumedRail.current = key;
        navigate(`/ask?q=${encodeURIComponent(q)}`, { replace: true });
      } else if (data === undefined) {
        return; // workspace detail still loading — leave unconsumed, retry
      } else {
        consumedRail.current = key;
        if (hasAsk) {
          setRailTab('ask');
          setRailOpen(true);
        }
      }
    } else if (railParam === 'test' && railAgentParam) {
      const q = searchParams.get('q');
      void api<{ channel_id: string; agent_name?: string }>(
        `/api/agents/${railAgentParam}/test-channel`,
        { method: 'POST' },
      )
        .then((r) => {
          setTestRail({ channelId: r.channel_id, label: r.agent_name ?? '', agentId: railAgentParam });
          if (q) {
            setTestSeed({ text: q, nonce: Date.now() });
            const p = new URLSearchParams(searchParams);
            p.delete('q');
            setSearchParams(p, { replace: true });
          }
          setRailTab('test');
          setRailOpen(true);
        })
        .catch(() => {});
      consumedRail.current = key;
    } else if (railParam === 'test' && testAvail) {
      const q = searchParams.get('q');
      if (q) {
        setTestSeed({ text: q, nonce: Date.now() });
        const p = new URLSearchParams(searchParams);
        p.delete('q');
        setSearchParams(p, { replace: true });
      }
      setRailTab('test');
      setRailOpen(true);
      consumedRail.current = key;
    } else {
      consumedRail.current = key;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railParam, railAgentParam, navType, isAskPage, hasAsk, data]);

  // Reflect rail state back into the URL — refresh or a copied link reopens
  // the same panel. replace: keeps tab flips out of history.
  useEffect(() => {
    // While workspace detail is loading, hasAsk is unknown — stripping a
    // deeplinked ?rail=ask here would strand the consumer's retry.
    if (data === undefined) return;
    const p = new URLSearchParams(searchParams);
    if (isAskPage) {
      // The path itself carries the state — ?rail= would fight it.
      p.delete('rail');
      p.delete('agent');
    } else if (railOpen && railTab === 'ask' && hasAsk) {
      p.set('rail', 'ask');
      p.delete('agent');
    } else if (railOpen && railTab === 'test' && (testRail?.agentId ?? ctxAgent)) {
      p.set('rail', 'test');
      p.set('agent', testRail?.agentId ?? ctxAgent!);
    } else {
      p.delete('rail');
      p.delete('agent');
    }
    // setSearchParams navigates through the render-time route match even
    // when called unconditionally from an effect — under a racing redirect
    // (legacy ?tab= → /:section) the stale match navigates back to the old
    // path, ping-ponging forever. Only write when the params differ.
    if (p.toString() === searchParams.toString()) return;
    setSearchParams(p, { replace: true });
  }, [railOpen, railTab, hasAsk, testRail, isAskPage, searchParams, setSearchParams, data]);
  // No active workspace → skip workspace-scoped queries (they'd 401 no_workspace)
  const hasWorkspace = Boolean(data?.workspace);
  const { data: attention } = useQuery({
    queryKey: ['attention-count'],
    queryFn: () => api<{ count: number; unread: number }>('/api/conversations/attention-count'),
    refetchInterval: 60_000,
    enabled: hasWorkspace,
  });
  // The nav badge previews what Inbox will show — scoped to the context
  // agent when one is selected. The unfiltered query above still feeds the
  // tab badge, which always counts the whole workspace.
  const { data: agentAttention } = useQuery({
    queryKey: ['attention-count', ctxAgent],
    queryFn: () =>
      api<{ count: number; unread: number }>(
        `/api/conversations/attention-count?agent_id=${ctxAgent}`,
      ),
    refetchInterval: 60_000,
    enabled: hasWorkspace && Boolean(ctxAgent),
  });

  // Mark a build step seen when its surface is open — either the builder
  // stage (/agents/new/:id?step=X) or the equivalent workspace section
  // (/agents/:id/knowledge, /integrations, /behavior, /tests, /channels).
  useEffect(() => {
    if (!ctxAgent) return;
    const builder = location.pathname.match(/^\/agents\/new\/([^/]+)$/);
    if (builder?.[1] === ctxAgent) {
      const s = searchParams.get('step');
      if (s && (BUILD_STEP_ORDER as string[]).includes(s)) markStepSeen(ctxAgent, s);
      return;
    }
    const sec = location.pathname.match(/^\/agents\/[^/]+\/(\w+)/)?.[1];
    const key = (Object.keys(SECTION_TO_STEP) as BuildStepKey[]).find(
      (k) => SECTION_TO_STEP[k] === sec,
    );
    if (key) markStepSeen(ctxAgent, key);
  }, [location.pathname, searchParams, ctxAgent]);
  /** A build step lights up on its builder URL AND on the workspace section
   *  that IS that surface — /agents/:id/knowledge is "Teach it", etc. */
  const buildNavActive = (key: BuildStepKey) => {
    if (
      location.pathname === `/agents/new/${ctxAgent}` &&
      (searchParams.get('step') ?? 'teach') === key
    )
      return true;
    const m = location.pathname.match(/^\/agents\/[^/]+\/(\w+)/);
    return m?.[1] === SECTION_TO_STEP[key];
  };
  const { data: billingStatus } = useQuery({
    queryKey: ['billing-status'],
    queryFn: () => api<{ plan_name: string }>('/api/billing/status'),
    enabled: hasWorkspace,
  });
  // Unseen-conversation count on the tab strip — the chime covers "now",
  // this covers "came back to the tab later". SSE invalidates the query so
  // it stays live; the 60s poll is the fallback.
  useEffect(() => setTabBadge(attention?.unread ?? 0), [attention?.unread]);
  const navigate = useNavigate();
  // Closing the rail on /ask has to leave the page too — otherwise the aside
  // just re-renders over an empty column. Back to wherever the user was.
  const closeRail = () => {
    setRailOpen(false);
    if (isAskPage) navigate(lastNonAsk.current);
  };
  const qc = useQueryClient();
  const openTab = useCallback((t: DockTab) => {
    setRailTab(t === 'copilot' ? 'ask' : 'test');
    setRailOpen(true);
    setDockCallout(false);
  }, []);
  const clearTestSeed = useCallback(() => setTestSeed(null), []);
  // In-page "Try in chat" — same landing spot as the ?rail=test&q= deep
  // link: the seed transfers to the fallback chat (or the builder's
  // listener) once the dock is open on the Test tab.
  const sendTestSeed = useCallback((text: string) => {
    setTestSeed({ text, nonce: Date.now() });
    setRailTab('test');
    setRailOpen(true);
  }, []);
  // Memoized — a fresh object per render makes every consumer's
  // dock-depending effect re-fire (setTestWiring in a loop is how this
  // file once froze navigation).
  const dockCtx = useMemo(
    () => ({
      open: railOpen,
      tab: (railTab === 'ask' ? 'copilot' : 'test') as DockTab,
      testAvailable: testAvail,
      testProvided,
      testSlot,
      setOpen: setRailOpen,
      openTab,
      setTestProvided,
      testWiring: wiring,
      setTestWiring,
      testVisitor,
      setTestVisitor: setChatVisitor,
      testSeed,
      clearTestSeed,
      sendTestSeed,
    }),
    [
      railOpen, railTab, testAvail, testProvided, testSlot, openTab,
      wiring, testVisitor, setChatVisitor, testSeed, clearTestSeed,
      sendTestSeed,
    ],
  );
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const soundOn = data?.user.notify.sound !== false;

  // Resume a deep link stashed by RequireAuth before a login round-trip —
  // e.g. a push click that hit an expired session.
  useEffect(() => {
    const next = sessionStorage.getItem('post-login-next');
    if (next && next.startsWith('/') && !next.startsWith('//')) {
      sessionStorage.removeItem('post-login-next');
      if (next !== window.location.pathname + window.location.search) navigate(next);
    }
  }, [navigate]);

  // Claim a pending Slack install — the public "Add to Slack" flow can
  // complete OAuth before sign-in; the grant waits on a cookie until an
  // admin session picks it up. Cheap no-op when nothing is pending.
  const claimedSlack = useRef(false);
  useEffect(() => {
    if (!hasWorkspace || claimedSlack.current || data?.user.role !== 'admin') return;
    claimedSlack.current = true;
    void api<{ claimed?: boolean; team_name?: string }>('/api/slack/claim', { method: 'POST' })
      .then((r) => {
        if (r?.claimed) {
          setToasts((t) => [
            ...t,
            {
              id: 'slack-claim',
              title: 'Slack connected',
              body: `${r.team_name ?? 'Your workspace'} is linked — alerts can route to it.`,
              url: '/settings',
            },
          ]);
        }
      })
      .catch(() => {});
  }, [hasWorkspace, data?.user.role]);

  const dismiss = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const onAlert = useCallback(
    (alert: StreamAlert) => {
      // resolved-alert republishes (takeover/resolve) refresh queries only —
      // they must not pop a "needs attention" toast. `pending` alerts fire
      // their toast when enrichment republishes with the real payload.
      if (alert.status !== 'open' || alert.pending) return;
      // One toast per conversation+issue — enrichment republishes, re-alert
      // bumps, and (rare) duplicate alert rows all update the same toast
      // rather than stacking. If it expired, the republish re-shows it.
      const id = `${alert.conversation_id}:${alert.type}`;
      const next = {
        id,
        title: alert.notification?.title ?? ALERT_LABELS[alert.type] ?? 'Needs attention',
        body: alert.notification?.body ?? alert.detail ?? 'A conversation needs a human.',
        url: alert.notification?.url ?? `/conversations/${alert.conversation_id}`,
      };
      setToasts((t) => (t.some((x) => x.id === id) ? t.map((x) => (x.id === id ? next : x)) : [...t, next]));
      if (!timers.current.has(id)) {
        timers.current.set(id, setTimeout(() => dismiss(id), 20_000));
        if (soundOn) playAlertSound();
      }
    },
    [dismiss, soundOn],
  );
  useStream(hasWorkspace, onAlert);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    window.location.href = '/';
  };

  const [promptEl, ask] = usePrompt();

  const switchWorkspace = async (workspaceId: string) => {
    if (workspaceId === '__new') {
      const name = await ask('Name the new workspace (e.g. a client or team):');
      if (!name?.trim()) return;
      await api('/auth/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
    } else {
      await api('/auth/switch', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
    }
    qc.clear();
    navigate('/conversations');
    window.location.reload();
  };




  const answerInvite = async (id: string, action: 'accept' | 'decline') => {
    await api(`/auth/invites/${id}/${action}`, { method: 'POST' });
    qc.clear();
    window.location.reload();
  };

  return (
    <DockContext.Provider value={dockCtx}>
    <div
      className={`layout${railOpen && !isAskPage ? ' dock-open' : ''}${
        (hasAsk || testAvail) && !isAskPage ? ' dock-available' : ''
      }${testAvail && onBuilderPage && !isAskPage ? ' dock-testable' : ''}${
        railOpen && splitActive ? ' dock-split' : ''
      }${railOpen && dockExpanded && !isAskPage ? ' dock-wide' : ''}${isAskPage ? ' ask-page' : ''}`}
    >
      {promptEl}
      <CommandPalette />
      <a className="skip-link" href="#main-content">Skip to content</a>
      {/* Clicking a nav item while the rail overlays (≤720px) folds it — even
          a click on the section you're already on, which changes no path. */}
      <nav
        className="sidebar"
        aria-label="Main navigation"
        onClick={(e) => {
          if (
            (e.target as HTMLElement).closest('a') &&
            window.matchMedia('(max-width: 720px)').matches
          ) {
            setRailOpen(false);
          }
        }}
      >
        <Link className="brand" to="/" title="Janis home">
          <BrandImg className="brand-wide" alt="Janis" />
          <BrandImg className="brand-mark" mark alt="" />
        </Link>
        {data?.workspace && (
          <ContextSwitcher
            data={data}
            agents={agentsData?.agents ?? []}
            currentAgentId={ctxAgent ?? undefined}
            planName={billingStatus?.plan_name}
            onGo={(path) => {
              // The switcher's workspace-header button goes to /conversations —
              // choosing the workspace means leaving the agent's context.
              if (path === '/conversations') clearLastAgent();
              navigate(path);
            }}
            onSwitchWorkspace={(id) => void switchWorkspace(id)}
            onCreateWorkspace={() => void switchWorkspace('__new')}
            onAnswerInvite={(id, action) => void answerInvite(id, action)}
            onAddAgent={() => navigate('/agents/new')}
          />
        )}
        {/* Agent subsection first — the agent's home + build surface, present
            only while an agent is in context. Overview is the dashboard; the
            six BUILD steps are the persistent way into each part (not a
            one-time wizard) with ✓/●/○ status; settings configures it. */}
        {currentAgent && (
          <div className="agent-nav">
            <div className="nav-sec">
              <Bot size={13} />
              <span>{currentAgent.name}</span>
            </div>
            <NavLink className="nav-indent" end to={`/agents/${ctxAgent}`}><span className="icon"><Gauge size={18} /></span><span className="label">Overview</span></NavLink>
            {!agentLive && <div className="nav-sec"><span>Build</span></div>}
            {buildNav(currentAgent, ctxAgent!, agentLive ?? false).map((s) => {
              const st = agentStatus?.steps[s.key];
              const g = agentStatus ? stepGlyph(s.key, st) : null;
              // Post-launch a permanent ✓ on every row is noise — marks
              // only flag steps that still need a look. Setup mode shows
              // every mark so progress is visible without the rail.
              const showMark = g && (!agentLive || g === 'half' || g === 'circle');
              return (
                <Link
                  key={s.key}
                  className={`nav-indent build-step${buildNavActive(s.key) ? ' active' : ''}`}
                  to={s.to}
                  title={`${s.label}${agentStatus ? ` · ${stepSubtitle(s.key, agentStatus)}` : ''}`}
                >
                  <span className="icon"><s.Icon size={18} /></span>
                  <span className="label">{s.label}</span>
                  {showMark && (
                    <span className={`step-mark${g === 'check' ? ' done' : g === 'check-muted' ? ' muted' : g === 'half' ? ' half' : ''}`}>
                      {g === 'check' || g === 'check-muted' ? '✓' : g === 'half' ? '◐' : '○'}
                    </span>
                  )}
                </Link>
              );
            })}
            <div className="nav-sec"><span>Configure</span></div>
            <NavLink className="nav-indent" to={`/agents/${ctxAgent}/settings`}><span className="icon"><Settings size={18} /></span><span className="label">Agent settings</span></NavLink>
          </div>
        )}
        {/* The shared customer layer — always the same spots, nested under
            the workspace header the way build steps nest under the agent.
            The four scoped-able pages default to the context agent; their
            on-page picker is the context control. scopedActive lights the
            workspace item for the scoped URL too — /agents/:id/inbox is
            still Inbox, not Agents. */}
        {data?.workspace && (
          <div className="nav-sec">
            <Building2 size={13} />
            <span>{data.workspace.name}</span>
          </div>
        )}
        <NavLink to="/conversations" className={({ isActive }) => `nav-indent${scopedActive('inbox')({ isActive }) ? ' active' : ''}`}>
          <span className="label">Inbox</span><span className="icon"><Inbox size={18} /></span>
          {(ctxAgent ? agentAttention : attention)?.count ? (
            <span className="nav-badge">{(ctxAgent ? agentAttention : attention)!.count}</span>
          ) : null}
        </NavLink>
        <NavLink to="/agents" end className="nav-indent"><span className="label">Agents</span><span className="icon"><Bot size={18} /></span></NavLink>
        <NavLink to="/contacts" className={({ isActive }) => `nav-indent${scopedActive('contacts')({ isActive }) ? ' active' : ''}`}><span className="label">Contacts</span><span className="icon"><Users size={18} /></span></NavLink>
        <NavLink to="/campaigns" className={({ isActive }) => `nav-indent${scopedActive('campaigns')({ isActive }) ? ' active' : ''}`}><span className="label">Campaigns</span><span className="icon"><Megaphone size={18} /></span></NavLink>
        {/* Workspace-wide sections vanish for agent-scoped users — they only
            hold grants on specific agents, not the workspace itself. */}
        {!data?.agent_scope && (
          <>
            <NavLink to="/reports" className={({ isActive }) => `nav-indent${scopedActive('reports')({ isActive }) ? ' active' : ''}`}><span className="label">Reports</span><span className="icon"><BarChart3 size={18} /></span></NavLink>
            {data?.operator && (
              <NavLink to="/errors" className="nav-indent"><span className="label">Errors</span><span className="icon"><Bug size={18} /></span></NavLink>
            )}
            <NavLink to="/billing" className="nav-indent"><span className="label">Billing</span><span className="icon"><CreditCard size={18} /></span></NavLink>
            <NavLink to="/settings" className="nav-indent"><span className="label">Settings</span><span className="icon"><Settings size={18} /></span></NavLink>
          </>
        )}
        {/* Copilot closes the nav, divided off from the workspace layer —
            the concierge rail is always one click away, scoped to the
            selected agent when the URL carries one. */}
        {data?.support_channel_id && (
          <>
            {!data?.agent_scope && <div className="nav-divider" />}
            <button
              type="button"
              className={`ask-toggle${(railVisible && railTab === 'ask') || isAskPage ? ' active' : ''}`}
              onClick={() => {
                if (isAskPage) {
                  closeRail();
                } else if (railOpen && railTab === 'ask') {
                  setRailOpen(false);
                } else {
                  setRailTab('ask');
                  setRailOpen(true);
                }
              }}
            >
              <span className="label">Copilot</span><span className="icon"><Sparkles size={18} /></span>
            </button>
          </>
        )}
        <div className="spacer" />
        <Link to="/docs?guide=operator" className="docs-link" style={{ fontSize: 12, opacity: 0.75 }}>
          <span className="label">Operator guide</span><span className="icon"><BookOpen size={16} /></span>
        </Link>
        <div className="user">
          {data?.user.name}
          {' · '}
          <a href="#" onClick={(e) => { e.preventDefault(); void logout(); }}>Sign out</a>
        </div>
      </nav>
      <main className="main" id="main-content" tabIndex={-1}>
        {data && data.invites.length > 0 && (
          <div className="card" style={{ marginBottom: 12 }}>
            {data.invites.map((inv) => (
              <div key={inv.id} className="row">
                <span className="grow">
                  You've been invited to <strong>{inv.workspace_name}</strong>
                </span>
                <button className="btn primary" onClick={() => void answerInvite(inv.id, 'accept')}>
                  Accept
                </button>
                <button className="btn" onClick={() => void answerInvite(inv.id, 'decline')}>
                  Decline
                </button>
              </div>
            ))}
          </div>
        )}
        {data?.agent_invites
          ?.filter((ai) => ai.workspace_id !== data.workspace?.id)
          .map((ai) => (
            <div key={ai.workspace_id} className="card" style={{ marginBottom: 12 }}>
              <div className="row">
                <span className="grow">
                  You've been added to <strong>{ai.agents.join(', ')}</strong> on{' '}
                  <strong>{ai.workspace_name}</strong>
                </span>
                <button
                  className="btn primary"
                  onClick={() => void switchWorkspace(ai.workspace_id)}
                >
                  Switch
                </button>
              </div>
            </div>
          ))}
        {data && !data.workspace ? (
          <WorkspaceChooser />
        ) : (
          <Outlet />
        )}
      </main>
      {/* Right-edge strip — the dock's permanent handle, present whenever
          there's anything to dock. Two stacked icons: Test (agent pages)
          above Copilot. Clicking an icon opens the dock on that tab;
          clicking the active one closes it. It claims its own 48px (the
          layout reserves it via .dock-available) so nothing hides under it. */}
      {!isAskPage && (hasAsk || testAvail) && (
        <div className="dock-strip" role="toolbar" aria-label="Dock">
          {testAvail && (
            <button
              className={`dock-strip-btn dock-strip-test${railOpen && railTab === 'test' ? ' active' : ''}`}
              title={railOpen && railTab === 'test' ? 'Close panel' : 'Test your agent'}
              aria-expanded={railOpen && railTab === 'test'}
              onClick={() =>
                railOpen && railTab === 'test'
                  ? setRailOpen(false)
                  : (setRailTab('test'), setRailOpen(true), setDockCallout(false))
              }
            >
              <FlaskConical size={16} />
              {(agentStatus?.test_conversations ?? 0) === 0 && (
                <span className="test-strip-dot" />
              )}
            </button>
          )}
          {hasAsk && (
            <button
              className={`dock-strip-btn dock-strip-copilot${railOpen && railTab === 'ask' ? ' active' : ''}`}
              title={railOpen && railTab === 'ask' ? 'Close panel' : 'Copilot — ask Janis'}
              aria-expanded={railOpen && railTab === 'ask'}
              onClick={() =>
                railOpen && railTab === 'ask'
                  ? setRailOpen(false)
                  : (setRailTab('ask'), setRailOpen(true))
              }
            >
              <Sparkles size={16} />
              {copilotUnread && <span className="test-strip-dot copilot-dot" />}
            </button>
          )}
        </div>
      )}
      {/* One-time nudge when there's a draft agent but no room to auto-open */}
      {dockCallout && !railOpen && testAvail && (
        <div className="test-callout">
          <button
            onClick={() => {
              setDockCallout(false);
              setRailTab('test');
              setRailOpen(true);
            }}
          >
            Chat with your draft agent →
          </button>
          <button aria-label="Dismiss" onClick={() => setDockCallout(false)}>
            <X size={13} />
          </button>
        </div>
      )}
      {railVisible && (
        <>
          {/* Under the reflow breakpoint the dock is a drawer — the dim
              reads "content is covered" and catches click-outside-close. */}
          {!isAskPage && railOpen && (
            <button
              className="test-dock-dim"
              aria-label="Close panel"
              onClick={() => setRailOpen(false)}
            />
          )}
          <aside
            className={`dock${isAskPage ? ' expanded' : ''}${splitActive ? ' split' : ''}${dockExpanded && !narrowWin ? ' wide' : ''}`}
          >
            <div className="dock-head">
              {bothTabs && !isAskPage ? (
                <div className="dock-tabs" role="tablist">
                  <button
                    role="tab"
                    aria-selected={railTab === 'test'}
                    className={`dock-tab dock-tab-test${railTab === 'test' ? ' active' : ''}`}
                    onClick={() => setRailTab('test')}
                  >
                    <FlaskConical size={13} /> Test
                    {(agentStatus?.test_conversations ?? 0) === 0 && (
                      <span className="test-strip-dot" />
                    )}
                  </button>
                  <button
                    role="tab"
                    aria-selected={railTab === 'ask'}
                    className={`dock-tab dock-tab-copilot${railTab === 'ask' ? ' active' : ''}`}
                    onClick={() => setRailTab('ask')}
                  >
                    <Sparkles size={13} /> Copilot
                    {copilotUnread && <span className="test-strip-dot copilot-dot" />}
                  </button>
                </div>
              ) : (
                <strong className="test-dock-title">
                  {railTab === 'ask'
                    ? 'Copilot'
                    : `Test your agent${testRail?.label ? ` — ${testRail.label}` : ''}`}
                </strong>
              )}
              <span className="grow" />
              {/* Split — both tabs side by side. Wide screens only (hidden
                  below ~1800px via CSS). */}
              {bothTabs && !isAskPage && !narrowWin && (
                <button
                  className="btn dock-split-btn"
                  title={dockSplit ? 'One panel' : 'Show both tabs side by side'}
                  onClick={() =>
                    setDockSplit((v) => {
                      const nv = !v;
                      try {
                        localStorage.setItem('janis.dock-split', nv ? '1' : '0');
                      } catch {
                        /* private mode */
                      }
                      return nv;
                    })
                  }
                >
                  <Columns2 size={14} />
                </button>
              )}
              {isAskPage ? (
                <button
                  className="btn"
                  title="Dock panel"
                  onClick={() => navigate(lastNonAsk.current)}
                >
                  <Minimize2 size={14} />
                </button>
              ) : (
                // No expand in drawer mode — there's no room for the
                // wide panel to mean anything.
                !narrowWin && (
                  <button
                    className="btn"
                    title={dockExpanded ? 'Dock panel' : 'Expand'}
                    onClick={() => setDockExpanded((v) => !v)}
                  >
                    {dockExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  </button>
                )
              )}
              {!isAskPage && (
                <button className="btn" onClick={closeRail} title="Close" aria-label="Close dock">
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="dock-bodies">
              {hasAsk && (
                <div
                  className="dock-page"
                  style={{ display: splitActive || railTab === 'ask' ? 'flex' : 'none' }}
                >
                  {/* Marker: Janis avatar, no badge — you're the owner
                      talking to Janis about your workspace. */}
                  <div className="test-dock-status" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <BrandImg mark className="dock-copilot-mark" alt="" />
                    <span
                      className="grow"
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      Janis · workspace copilot
                    </span>
                    <CopilotHistory
                      channelId={data!.support_channel_id!}
                      currentThread={askThread ?? undefined}
                      onPick={setAskThread}
                    />
                    <button
                      className="link small"
                      title="Start a fresh copilot chat — earlier threads stay in History"
                      onClick={() => setAskThread(freshCopilotThread())}
                    >
                      <MessageSquarePlus
                        size={11}
                        style={{ verticalAlign: -1, marginRight: 3 }}
                      />
                      New chat
                    </button>
                  </div>
                  <AskJanis
                    key={askThread ?? 'default'}
                    channelId={data!.support_channel_id!}
                    agentId={ctxAgent ?? undefined}
                    thread={askThread ?? undefined}
                    seedMessage={askSeed?.text}
                    seedNonce={askSeed?.nonce}
                    draftMessage={copilotDraft?.text}
                    draftNonce={copilotDraft?.nonce}
                    placeholder="Ask Janis to change or explain your setup…"
                    onAgentReply={() => setCopilotUnread(true)}
                    hideHeader
                  />
                </div>
              )}
              {testAvail && (
                <div
                  className="dock-page"
                  style={{ display: splitActive || railTab === 'test' ? 'flex' : 'none' }}
                >
                  {/* Pages with wired test chrome (the builder) portal a
                      status row + notices into this slot; the chat itself is
                      Layout's single instance — it never remounts across
                      navigation, only its handlers swap. */}
                  <div className="test-dock-body">
                    <div ref={setTestSlot} style={{ display: 'contents' }} />
                    {/* One header row, always Layout's — a page's extra
                        status arrives via wiring.statusText, so the
                        builder ↔ page handoff changes text, not DOM. */}
                    {chatChannelId && (
                      <div
                        className="test-dock-status"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          flexWrap: 'nowrap',
                        }}
                      >
                        <span
                          className="muted grow"
                          style={{
                            fontSize: 11,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {(!testProvided && fallbackNotice) ||
                            `Testing ${
                              agentsData?.agents.find((a) => a.id === chatAgentId)?.name ||
                              testRail?.label ||
                              'agent'
                            }` +
                              (wiring?.statusText ? ` · ${wiring.statusText}` : '')}
                        </span>
                        <TestChatHistory
                          agentId={chatAgentId!}
                          channelId={chatChannelId}
                          currentVisitor={testVisitor ?? undefined}
                          onPick={(v) => {
                            setChatVisitor(v);
                            // A pending "Try in chat" seed belongs to the
                            // thread it was fired into — don't let the
                            // remount re-send it here.
                            setFallbackSeed(null);
                            wiring?.handlers.current.onVisitorChange?.(v, false);
                          }}
                        />
                        <button
                          className="link small"
                          title="Start a fresh test conversation"
                          onClick={() => {
                            const v = freshTestVisitor();
                            setChatVisitor(v);
                            setFallbackSeed(null);
                            wiring?.handlers.current.onVisitorChange?.(v, true);
                          }}
                        >
                          <MessageSquarePlus
                            size={11}
                            style={{ verticalAlign: -1, marginRight: 3 }}
                          />
                          New chat
                        </button>
                      </div>
                    )}
                    {chatChannelId ? (
                      <AskJanis
                        key={`${chatChannelId}:${testVisitor ?? 'base'}`}
                        channelId={chatChannelId}
                        visitorOverride={testVisitor ?? undefined}
                        asCustomer
                        hideHeader
                        placeholder="You're chatting as a customer…"
                        seedMessage={
                          wiring
                            ? (wiring.seed?.text ?? undefined)
                            : fallbackSeed?.text
                        }
                        seedNonce={
                          wiring ? wiring.seed?.nonce : fallbackSeed?.nonce
                        }
                        focusSignal={wiring?.focusSignal}
                        onCustomerMessage={wiring?.handlers.current.onCustomerMessage}
                        verdictFor={(cust, reply, turns) =>
                          (wiring?.handlers.current.verdictFor ?? fallbackVerdictFor)(
                            cust,
                            reply,
                            turns,
                          )
                        }
                        onShowScenario={(id) =>
                          (wiring?.handlers.current.onShowScenario ?? fallbackShowScenario)(id)
                        }
                        onCorrect={(ctx) =>
                          (wiring?.handlers.current.onCorrect ?? fallbackOnCorrect)(ctx)
                        }
                        onSaveTest={(ctx) =>
                          (wiring?.handlers.current.onSaveTest ?? fallbackOnSaveTest)(ctx)
                        }
                      />
                    ) : (
                      !testProvided && (
                        <div className="muted" style={{ padding: 14 }}>
                          Opening test channel…
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}
            </div>
          </aside>
        </>
      )}
      {/* Fallback-panel correction card — same modal the builder uses;
          re-running the fixed scenario is left to the test surface. */}
      {fallbackCorrect &&
        chatAgentId &&
        (() => {
          const fixAgent = agentsData?.agents.find((a) => a.id === chatAgentId);
          if (!fixAgent) return null;
          return (
            <div className="modal-backdrop" onClick={() => setFallbackCorrect(null)}>
              <div
                className="modal"
                style={{ width: 560, maxHeight: '78vh', overflowY: 'auto' }}
                onClick={(e) => e.stopPropagation()}
              >
                <CorrectThisCard
                  agentId={chatAgentId}
                  cfg={fixAgent.config}
                  target={fallbackCorrect}
                  onClose={() => setFallbackCorrect(null)}
                  onSaved={() => {
                    void qc.invalidateQueries({ queryKey: ['agents'] });
                    void qc.invalidateQueries({
                      queryKey: ['build-status', chatAgentId],
                    });
                  }}
                  onFixed={() => {
                    void qc.invalidateQueries({
                      queryKey: ['agent-tests', chatAgentId],
                    });
                  }}
                />
              </div>
            </div>
          );
        })()}
      <PushBanner />
      <div className="toast-stack">
        {toasts.map((t) => (
          <button
            key={t.id}
            className="toast"
            onClick={() => {
              dismiss(t.id);
              navigate(t.url);
            }}
          >
            <BrandImg mark className="toast-icon" alt="" />
            <span className="toast-body">
              <strong>{t.title}</strong>
              <span>{t.body}</span>
            </span>
            <span
              className="toast-x"
              role="button"
              aria-label="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
              }}
            >
              <X size={13} />
            </span>
          </button>
        ))}
      </div>
    </div>
    </DockContext.Provider>
  );
}

/** Shown when the session has no active workspace — accept an invite above,
 * or create a workspace here. */
function WorkspaceChooser() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <strong>Create a workspace</strong>
      <div className="muted" style={{ margin: '6px 0 10px' }}>
        You're not a member of a workspace yet — create one, or accept an invite above.
      </div>
      <div className="row">
        <input
          value={name}
          placeholder="Workspace name"
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="btn primary"
          disabled={!name.trim() || busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api('/auth/workspaces', {
                method: 'POST',
                body: JSON.stringify({ name: name.trim() }),
              });
              qc.clear();
              window.location.reload();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'failed');
              setBusy(false);
            }
          }}
        >
          Create
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
