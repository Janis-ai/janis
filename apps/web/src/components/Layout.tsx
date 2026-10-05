import { useCallback, useEffect, useRef, useState } from 'react';
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
import { railBus, type RailRequest } from '../lib/railBus';
import {
  BarChart3, BookOpen, Bot, Bug, Building2, Check, ChevronRight, ChevronsUpDown,
  Circle, CircleDot, CreditCard, Gauge, Inbox, Megaphone,
  Settings, Sparkles, Users, X,
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

/** Sidebar build nav — hosted agents get all six steps (each opens the
 *  builder stage for it); external-webhook agents only have a deploy
 *  surface, which links straight to the channels list. */
function buildNav(agent: Agent, agentId: string) {
  const steps: { key: BuildStepKey; label: string; to: string }[] = [
    { key: 'create', label: 'Create', to: `/agents/new/${agentId}?step=create` },
    { key: 'teach', label: 'Teach it', to: `/agents/new/${agentId}?step=teach` },
    { key: 'guide', label: 'Guide it', to: `/agents/new/${agentId}?step=guide` },
    { key: 'abilities', label: 'Abilities', to: `/agents/new/${agentId}?step=abilities` },
    { key: 'try', label: 'Try it', to: `/agents/new/${agentId}?step=try` },
    { key: 'deploy', label: 'Deploy', to: `/agents/new/${agentId}?step=deploy` },
  ];
  return janisBrain(agent)
    ? steps
    : [{ key: 'deploy' as const, label: 'Deploy', to: `/agents/${agentId}/channels` }];
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
                  <button type="button" className="ctx-item" onClick={onCreateWorkspace}>
                    ＋ Create workspace
                  </button>
                  {data!.invites.map((inv) => (
                    <div key={inv.id} className="ctx-item ctx-invite">
                      <Building2 size={13} className="ctx-ic" />
                      <span className="grow">Invited to {inv.workspace_name}</span>
                      <button type="button" className="btn sm" onClick={() => onAnswerInvite(inv.id, 'accept')}>
                        Join
                      </button>
                      <button type="button" className="btn sm" onClick={() => onAnswerInvite(inv.id, 'decline')}>
                        Decline
                      </button>
                    </div>
                  ))}
                  {data!.agent_invites.map((ai) => (
                    <button
                      key={ai.workspace_id}
                      type="button"
                      className="ctx-item ctx-invite"
                      onClick={() => onSwitchWorkspace(ai.workspace_id)}
                    >
                      <Building2 size={13} className="ctx-ic" />
                      <span className="grow">Join {ai.workspace_name} (agent access)</span>
                    </button>
                  ))}
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
  // The right rail is one slot with tabs: Ask Janis (concierge) and an agent
  // test chat. Both stay mounted while the rail is open — the inactive pane
  // is hidden so scroll position and drafts survive tab switches.
  const [railOpen, setRailOpen] = useState(false);
  const [railTab, setRailTab] = useState<'ask' | 'test'>('ask');
  const [testRail, setTestRail] = useState<RailRequest | null>(null);
  const [askSeed, setAskSeed] = useState<string | null>(null);
  useEffect(
    () =>
      railBus.subscribe((r) => {
        if (r.seed) {
          setAskSeed(r.seed);
          setRailTab('ask');
        } else {
          setTestRail(r);
          setRailTab('test');
        }
        setRailOpen(true);
      }),
    [],
  );
  const hasAsk = Boolean(data?.support_channel_id);
  const hasBoth = hasAsk && Boolean(testRail);

  // Agent context: explicit on /agents/:id/* URLs, persisted elsewhere so
  // the shared pages keep defaulting to the selected agent. The sidebar's
  // agent subsection, the concierge rail and the inbox badge all key off it.
  const ctxAgent = useContextAgent();
  const { data: agentsData } = useAgents();
  const currentAgent = agentsData?.agents.find((a) => a.id === ctxAgent);

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

  const railVisible =
    (railOpen && ((railTab === 'ask' && hasAsk) || (railTab === 'test' && testRail))) ||
    (isAskPage && hasAsk);

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
      setAskSeed(q);
      const p = new URLSearchParams(searchParams);
      p.delete('q');
      setSearchParams(p, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAskPage, hasAsk, data, searchParams]);

  // At ≤720px the rail is position:fixed over the whole view — a nav click
  // beneath it lands on an invisible page, so fold the rail on navigation.
  // Declared before the ?rail= consumer so a deeplinked rail still opens.
  const prevPath = useRef(location.pathname);
  useEffect(() => {
    if (location.pathname === prevPath.current) return;
    prevPath.current = location.pathname;
    if (window.matchMedia('(max-width: 720px)').matches) setRailOpen(false);
  }, [location.pathname]);

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
      void api<{ channel_id: string; agent_name?: string }>(
        `/api/agents/${railAgentParam}/test-channel`,
        { method: 'POST' },
      )
        .then((r) => {
          setTestRail({ channelId: r.channel_id, label: r.agent_name ?? '', agentId: railAgentParam });
          setRailTab('test');
          setRailOpen(true);
        })
        .catch(() => {});
      consumedRail.current = key;
    } else if (railParam === 'test' && testRail) {
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
    } else if (railOpen && railTab === 'test' && testRail?.agentId) {
      p.set('rail', 'test');
      p.set('agent', testRail.agentId);
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
  const { data: buildStatus } = useBuildStatus(
    hasWorkspace && currentAgent ? (ctxAgent ?? undefined) : undefined,
  );
  // The first unfinished step gets the ● "next" marker; done ✓, rest ○.
  // External agents only render Deploy — compute next over rendered keys.
  const renderedSteps = currentAgent ? buildNav(currentAgent, ctxAgent!).map((s) => s.key) : [];
  const nextBuildStep = buildStatus
    ? (BUILD_STEP_ORDER.filter((k) => renderedSteps.includes(k)).find((k) => !buildStatus.steps[k]) ?? null)
    : null;
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
    <div className={`layout${railVisible ? ' ask-open' : ''}${isAskPage ? ' ask-page' : ''}`}>
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
            <NavLink className="nav-indent" end to={`/agents/${ctxAgent}`}><span className="label">Overview</span><span className="icon"><Gauge size={18} /></span></NavLink>
            <div className="nav-sec">Build</div>
            {buildNav(currentAgent, ctxAgent!).map((s) => (
              <Link
                key={s.key}
                className={`nav-indent build-step${buildNavActive(s.key) ? ' active' : ''}`}
                to={s.to}
              >
                <span className="label">{s.label}</span>
                <span className={`step-mark ${
                  buildStatus?.steps[s.key]
                    ? 'done'
                    : buildStatus && nextBuildStep === s.key
                      ? 'next'
                      : 'todo'
                }`}>
                  {buildStatus?.steps[s.key] ? (
                    <Check size={12} />
                  ) : buildStatus && nextBuildStep === s.key ? (
                    <CircleDot size={12} />
                  ) : (
                    <Circle size={12} />
                  )}
                </span>
              </Link>
            ))}
            <div className="nav-sec">Configure</div>
            <NavLink className="nav-indent" to={`/agents/${ctxAgent}/settings`}><span className="label">Agent settings</span><span className="icon"><Settings size={18} /></span></NavLink>
          </div>
        )}
        {/* The shared customer layer — always the same spots. The four
            scoped-able pages default to the context agent; their on-page
            picker is the context control. scopedActive lights the workspace
            item for the scoped URL too — /agents/:id/inbox is still Inbox,
            not Agents. */}
        <NavLink to="/conversations" className={scopedActive('inbox')}>
          <span className="label">Inbox</span><span className="icon"><Inbox size={18} /></span>
          {(ctxAgent ? agentAttention : attention)?.count ? (
            <span className="nav-badge">{(ctxAgent ? agentAttention : attention)!.count}</span>
          ) : null}
        </NavLink>
        <NavLink to="/agents" end><span className="label">Agents</span><span className="icon"><Bot size={18} /></span></NavLink>
        <NavLink to="/contacts" className={scopedActive('contacts')}><span className="label">Contacts</span><span className="icon"><Users size={18} /></span></NavLink>
        <NavLink to="/campaigns" className={scopedActive('campaigns')}><span className="label">Campaigns</span><span className="icon"><Megaphone size={18} /></span></NavLink>
        {/* Workspace-wide sections vanish for agent-scoped users — they only
            hold grants on specific agents, not the workspace itself. */}
        {!data?.agent_scope && (
          <>
            <NavLink to="/reports" className={scopedActive('reports')}><span className="label">Reports</span><span className="icon"><BarChart3 size={18} /></span></NavLink>
            {data?.operator && (
              <NavLink to="/errors"><span className="label">Errors</span><span className="icon"><Bug size={18} /></span></NavLink>
            )}
            <NavLink to="/billing"><span className="label">Billing</span><span className="icon"><CreditCard size={18} /></span></NavLink>
            <NavLink to="/settings"><span className="label">Settings</span><span className="icon"><Settings size={18} /></span></NavLink>
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
      {railVisible && (
        <aside className={`ask-rail${isAskPage ? ' expanded' : ''}`}>
          {hasBoth && (
            <div className="ask-tabs">
              <button
                className={`ask-tab${railTab === 'ask' ? ' active' : ''}`}
                onClick={() => setRailTab('ask')}
              >
                Ask Janis
              </button>
              <button
                className={`ask-tab${railTab === 'test' ? ' active' : ''}`}
                onClick={() => setRailTab('test')}
              >
                Test{testRail!.label ? ` — ${testRail!.label}` : ''}
              </button>
              <span className="grow" />
              <button className="btn" onClick={closeRail} title="Close" aria-label="Close panel"><X size={14} /></button>
            </div>
          )}
          {hasAsk && (
            <div style={{ display: railTab === 'ask' ? 'contents' : 'none' }}>
              <AskJanis
                channelId={data!.support_channel_id!}
                agentId={ctxAgent ?? undefined}
                seedMessage={askSeed ?? undefined}
                expanded={isAskPage}
                onToggleExpand={() => navigate(isAskPage ? lastNonAsk.current : '/ask')}
                onClose={hasBoth ? undefined : closeRail}
              />
            </div>
          )}
          {testRail && (
            <div
              key={testRail.channelId}
              style={{ display: railTab === 'test' ? 'contents' : 'none' }}
            >
              <AskJanis
                channelId={testRail.channelId}
                badge="TEST"
                asCustomer
                onClose={hasBoth ? undefined : closeRail}
              />
            </div>
          )}
        </aside>
      )}
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
          </button>
        ))}
      </div>
    </div>
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
