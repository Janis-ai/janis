import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAttentionCount, useMe } from '../api/hooks';
import { useStream, type StreamAlert } from '../lib/useStream';
import { playAlertSound } from '../lib/alertSound';
import PushBanner from './PushBanner';

interface Toast {
  id: string;
  title: string;
  body: string;
  url: string;
}

const ALERT_LABELS: Record<string, string> = {
  failure: 'Agent failure',
  help_request: 'Handoff requested',
  custom: 'Alert',
  inactivity: 'Inactive conversation',
  keyword: 'Keyword match',
  sla: 'SLA breach — still unclaimed',
};

export default function Layout() {
  const { data } = useMe();
  const { data: attention } = useAttentionCount();
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
      // Same alert + same timestamp = an enrichment republish → update the
      // toast in place. A bumped timestamp (5-min re-alert) is a new toast.
      const id = `${alert.id}:${alert.created_at}`;
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
  useStream(true, onAlert);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    navigate('/login');
  };

  return (
    <div className="layout">
      <nav className="sidebar">
        <Link className="brand" to="/" title="Janis home"><img src="/img/janis-top.png" alt="Janis" style={{ height: 26, display: 'block' }} /></Link>
        <NavLink to="/conversations" end><span className="label">Conversations</span><span className="icon">▤</span>{attention?.count ? <span className="nav-badge">{attention.count}</span> : null}</NavLink>
        <NavLink to="/agents"><span className="label">Agents</span><span className="icon">◈</span></NavLink>
        <NavLink to="/reports"><span className="label">Reports</span><span className="icon">◫</span></NavLink>
        <NavLink to="/integrations"><span className="label">Integrations</span><span className="icon">⇄</span></NavLink>
        <NavLink to="/billing"><span className="label">Billing</span><span className="icon">$</span></NavLink>
        <NavLink to="/settings"><span className="label">Settings</span><span className="icon">⚙</span></NavLink>
        <div className="spacer" />
        <div className="user">
          {data?.user.name}
          <br />
          <a href="#" onClick={(e) => { e.preventDefault(); void logout(); }}>Sign out</a>
        </div>
      </nav>
      <main className="main">
        <Outlet />
      </main>
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
            <img src="/img/janis-logo-bot.png" className="toast-icon" alt="" />
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
