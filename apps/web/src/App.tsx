import { Component, type ReactNode, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from './api/client';
import { useMe } from './api/hooks';
import Layout from './components/Layout';
import Login from './pages/Login';
import Landing from './pages/Landing';
import { Privacy, Terms } from './pages/Legal';
import Docs from './pages/Docs';
import Conversations from './pages/Conversations';
import ConversationPage from './pages/ConversationPage';
import Agents from './pages/Agents';
import AgentDetail from './pages/AgentDetail';
import Reports from './pages/Reports';
import Integrations from './pages/Integrations';
import Billing from './pages/Billing';
import Settings from './pages/Settings';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error(error, info.componentStack);
    const params = new URLSearchParams({
      msg: error.message,
      stack: (error.stack ?? '').slice(0, 1500),
      comp: (info.componentStack ?? '').slice(0, 500),
      at: window.location.pathname,
    });
    fetch(`/api/__client_error?${params}`).catch(() => {});
  }
  render() {
    if (this.state.error) {
      return (
        <div className="login-wrap">
          <div className="error">Something went wrong: {this.state.error.message}</div>
          <a href="/conversations">Back to conversations</a>
        </div>
      );
    }
    return this.props.children;
  }
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { isLoading, error } = useMe();
  const location = useLocation();
  if (isLoading) return <div className="login-wrap muted">Loading…</div>;
  if (error instanceof ApiError && error.status === 401) {
    // Stash the deep link (e.g. a push/toast target) so login can return
    // to it — sessionStorage survives the SPA bounce and OAuth round-trips.
    sessionStorage.setItem('post-login-next', location.pathname + location.search);
    return <Navigate to="/login" replace />;
  }
  if (error) return <div className="login-wrap error">{error.message}</div>;
  return children;
}

/** The service worker posts 'janis:open' after a push-notification click —
 * route to it client-side (covers PWA launches that land on start_url). */
function PushDeepLink() {
  const navigate = useNavigate();
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | undefined;
      if (d?.type !== 'janis:open' || !d.url?.startsWith('/') || d.url.startsWith('//')) return;
      navigate(d.url);
    };
    sw.addEventListener('message', onMsg);
    return () => sw.removeEventListener('message', onMsg);
  }, [navigate]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <PushDeepLink />
      <ErrorBoundary>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/docs" element={<Docs />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/conversations" element={<Conversations />} />
          <Route path="/inbox" element={<Navigate to="/conversations" replace />} />
          <Route path="/channels" element={<Navigate to="/conversations" replace />} />
          <Route path="/conversations/:id" element={<ConversationPage />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/agents/:id" element={<AgentDetail />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/billing" element={<Billing />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
