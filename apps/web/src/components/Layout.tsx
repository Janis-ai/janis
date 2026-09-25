import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useMe } from '../api/hooks';
import { useStream, type StreamAlert } from '../lib/useStream';
import { playAlertSound } from '../lib/alertSound';
import PushBanner from './PushBanner';
import { AskJanis } from './AskJanis';
import { railBus, type RailRequest } from '../lib/railBus';

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
};

export default function Layout() {
  const { data } = useMe();
  // The right rail is one slot with tabs: Ask Janis (concierge) and an agent
  // test chat. Both stay mounted while the rail is open — the inactive pane
  // is hidden so scroll position and drafts survive tab switches.
  const [railOpen, setRailOpen] = useState(false);
  const [railTab, setRailTab] = useState<'ask' | 'test'>('ask');
  const [testRail, setTestRail] = useState<RailRequest | null>(null);
  useEffect(
    () =>
      railBus.subscribe((r) => {
        setTestRail(r);
        setRailTab('test');
        setRailOpen(true);
      }),
    [],
  );
  const hasAsk = Boolean(data?.support_channel_id);
  const hasBoth = hasAsk && Boolean(testRail);
  const railVisible = railOpen && ((railTab === 'ask' && hasAsk) || (railTab === 'test' && testRail));

  // Deeplinks: ?rail=ask | ?rail=test&agent=<id> — merged into the existing
  // params so page params like ?tab= survive. Consumed once per combo.
  const [searchParams, setSearchParams] = useSearchParams();
  const railParam = searchParams.get('rail');
  const railAgentParam = searchParams.get('agent');
  const consumedRail = useRef('');
  useEffect(() => {
    const key = `${railParam}:${railAgentParam}`;
    if (key === consumedRail.current) return;
    consumedRail.current = key;
    if (railParam === 'ask') {
      setRailTab('ask');
      setRailOpen(true);
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
    } else if (railParam === 'test' && testRail) {
      setRailTab('test');
      setRailOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railParam, railAgentParam]);

  // Reflect rail state back into the URL — refresh or a copied link reopens
  // the same panel. replace: keeps tab flips out of history.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (railOpen && railTab === 'ask' && hasAsk) {
          p.set('rail', 'ask');
          p.delete('agent');
        } else if (railOpen && railTab === 'test' && testRail?.agentId) {
          p.set('rail', 'test');
          p.set('agent', testRail.agentId);
        } else {
          p.delete('rail');
          p.delete('agent');
        }
        return p;
      },
      { replace: true },
    );
  }, [railOpen, railTab, hasAsk, testRail, setSearchParams]);
  // No active workspace → skip workspace-scoped queries (they'd 401 no_workspace)
  const hasWorkspace = Boolean(data?.workspace);
  const { data: attention } = useQuery({
    queryKey: ['attention-count'],
    queryFn: () => api<{ count: number }>('/api/conversations/attention-count'),
    refetchInterval: 60_000,
    enabled: hasWorkspace,
  });
  const navigate = useNavigate();
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

  const dismiss = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const onAlert = useCallback(
    (alert: StreamAlert) => {
      // resolved-alert republishes (takeover/resolve) refresh queries only —
      // they must not pop a "needs attention" toast
      if (alert.status !== 'open') return;
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

  const switchWorkspace = async (workspaceId: string) => {
    if (workspaceId === '__new') {
      const name = window.prompt('Name the new workspace (e.g. a client or team):');
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
    <div className={`layout${railVisible ? ' ask-open' : ''}`}>
      <nav className="sidebar">
        <Link className="brand" to="/" title="Janis home">
          <img className="brand-wide" src="/img/janis-top.png" alt="Janis" />
          <img className="brand-mark" src="/img/janis-mark.png" alt="" />
        </Link>
        <NavLink to="/conversations" end><span className="label">Conversations</span><span className="icon">▤</span>{attention?.count ? <span className="nav-badge">{attention.count}</span> : null}</NavLink>
        <NavLink to="/agents"><span className="label">Agents</span><span className="icon">◈</span></NavLink>
        <NavLink to="/reports"><span className="label">Reports</span><span className="icon">◫</span></NavLink>
        <NavLink to="/integrations"><span className="label">Channels</span><span className="icon">⇄</span></NavLink>
        <NavLink to="/billing"><span className="label">Billing</span><span className="icon">$</span></NavLink>
        <NavLink to="/settings"><span className="label">Settings</span><span className="icon">⚙</span></NavLink>
        {data?.support_channel_id && (
          <button
            type="button"
            className={`ask-toggle${railVisible && railTab === 'ask' ? ' active' : ''}`}
            onClick={() => {
              if (railOpen && railTab === 'ask') setRailOpen(false);
              else {
                setRailTab('ask');
                setRailOpen(true);
              }
            }}
          >
            <span className="label">Ask Janis</span><span className="icon">✦</span>
          </button>
        )}
        <div className="spacer" />
        <div className="user">
          {data && data.workspaces.length > 1 ? (
            <select
              className="ws-switch"
              value={data.workspace?.id ?? ''}
              onChange={(e) => void switchWorkspace(e.target.value)}
              title="Switch workspace"
            >
              {data.workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
              <option value="__new">＋ New workspace…</option>
            </select>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>{data?.workspace?.name}</span>
          )}
          <br />
          {data?.user.name}
          {' · '}
          <a href="#" onClick={(e) => { e.preventDefault(); void logout(); }}>Sign out</a>
        </div>
      </nav>
      <main className="main">
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
        {data && !data.workspace ? (
          <WorkspaceChooser />
        ) : (
          <Outlet />
        )}
      </main>
      {railVisible && (
        <aside className="ask-rail">
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
              <button className="btn" onClick={() => setRailOpen(false)} title="Close">✕</button>
            </div>
          )}
          {hasAsk && (
            <div style={{ display: railTab === 'ask' ? 'contents' : 'none' }}>
              <AskJanis
                channelId={data!.support_channel_id!}
                onClose={hasBoth ? undefined : () => setRailOpen(false)}
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
                onClose={hasBoth ? undefined : () => setRailOpen(false)}
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
            <img src="/img/janis-mark.png" className="toast-icon" alt="" />
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
