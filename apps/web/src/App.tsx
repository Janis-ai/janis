import { Component, type ReactElement, type ReactNode, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api/client';
import type { Channel } from '@janis/shared';
import { useMe } from './api/hooks';
import Layout from './components/Layout';
import Login from './pages/Login';
import Landing from './pages/Landing';
import { Privacy, Terms } from './pages/Legal';
import Docs from './pages/Docs';
import Conversations from './pages/Conversations';
import ConversationPage from './pages/ConversationPage';
import Agents from './pages/Agents';
import AgentBuilder from './pages/AgentBuilder';
import AgentDetail from './pages/AgentDetail';
import AgentOverview from './pages/AgentOverview';
import Reports from './pages/Reports';
import Errors from './pages/Errors';
import Billing from './pages/Billing';
import Settings from './pages/Settings';
import { HelpCenter, HelpArticle, HelpDomain } from './pages/HelpCenter';
import { ChatDomain } from './pages/ChatDomain';
import { Status } from './pages/Status';
import { Contacts, ContactDetail } from './pages/Contacts';
import Campaigns from './pages/Campaigns';
import ChannelPage from './pages/ChannelPage';
import { finishOpenRouterCallback } from './lib/openrouterAuth';
import { reportClientError } from './lib/errorReporter';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error(error, info.componentStack);
    void reportClientError(error.message, {
      stack: `${error.stack ?? ''}\n\ncomponent stack:${info.componentStack ?? ''}`.slice(0, 10_000),
      trigger: 'react-error-boundary',
    });
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

function RequireAuth({ children }: { children: ReactElement }) {
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

/** Channels are managed per agent now — old /integrations/:id links resolve
 * to the owning agent's channel settings page. */
function ChannelRedirect() {
  const { channelId } = useParams();
  const { data, error } = useQuery({
    queryKey: ['channel', channelId],
    queryFn: () => api<{ channel: Channel }>(`/api/channels/${channelId}`),
    enabled: Boolean(channelId),
    retry: false,
  });
  if (error) return <Navigate to="/agents" replace />;
  if (!data) return <div className="login-wrap muted">Loading…</div>;
  return (
    <Navigate
      to={`/agents/${data.channel.agent_id}/channels/${channelId}`}
      replace
    />
  );
}



/** Thin wrappers — the same page components serve the workspace context
 *  unscoped and the agent context pinned to that agent. */
function AgentInbox() {
  const { id } = useParams();
  return <Conversations key={id} agentId={id} />;
}
function AgentContacts() {
  const { id } = useParams();
  return <Contacts key={id} agentId={id} />;
}
function AgentCampaigns() {
  const { id } = useParams();
  return <Campaigns key={id} agentId={id} />;
}
function AgentReports() {
  const { id } = useParams();
  return <Reports key={id} agentId={id} />;
}
function AgentUsageRedirect() {
  const { id } = useParams();
  return <Navigate to={`/agents/${id}/reports`} replace />;
}

/** OpenRouter OAuth landing: exchange ?code, stash the key, bounce back to
 * the agent page that started the flow (stored in sessionStorage). */
function LlmCallback() {
  useEffect(() => {
    void finishOpenRouterCallback();
  }, []);
  return <div className="login-wrap muted">Connecting to OpenRouter…</div>;
}

/** Hosts that serve the console — everything else is treated as a CNAME'd
 * help domain (the workspace claims it via Settings → Workspace). */
const APP_HOSTS = new Set([
  'app.janis.ai',
  'janis.ai',
  'www.janis.ai',
  'janis-api-696050206949.us-east1.run.app',
  'localhost',
  '127.0.0.1',
]);
const isAppHost = () =>
  APP_HOSTS.has(window.location.hostname) ||
  /\.(devin\.app|loca\.lt|ngrok[^.]*\.(io|dev|com))$/.test(window.location.hostname);

export default function App() {
  return (
    <BrowserRouter>
      <PushDeepLink />
      <ErrorBoundary>
      <Routes>
        <Route path="/" element={isAppHost() ? <Landing /> : <ChatDomain />} />
        <Route path="/login" element={<Login />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/status" element={<Status />} />
        <Route path="/llm/callback" element={<LlmCallback />} />
        <Route path="/help/:agentId" element={<HelpCenter />} />
        <Route path="/help/:agentId/:articleId" element={<HelpArticle />} />
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
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/contacts/:id" element={<ContactDetail />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/agents/new" element={<AgentBuilder />} />
          <Route path="/agents/:id" element={<AgentOverview />} />
          {/* Agent context — every section is its own path so the sidebar
              can flip the whole nav between workspace and agent. */}
          <Route path="/agents/:id/inbox" element={<AgentInbox />} />
          <Route path="/agents/:agentId/inbox/:id" element={<ConversationPage />} />
          <Route path="/agents/:id/contacts" element={<AgentContacts />} />
          <Route path="/agents/:id/contacts/:cid" element={<ContactDetail />} />
          <Route path="/agents/:id/campaigns" element={<AgentCampaigns />} />
          <Route path="/agents/:id/reports" element={<AgentReports />} />
          <Route path="/agents/:id/usage" element={<AgentUsageRedirect />} />
          <Route path="/agents/:id/channels/:channelId" element={<ChannelPage />} />
          <Route path="/agents/:id/:section" element={<AgentDetail />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/usage" element={<Navigate to="/reports" replace />} />
          <Route path="/errors" element={<Errors />} />
          <Route path="/integrations" element={<Navigate to="/agents" replace />} />
          <Route path="/integrations/:channelId" element={<ChannelRedirect />} />
          <Route path="/billing" element={<Billing />} />
          <Route path="/settings" element={<Settings />} />
          {/* Ask Janis expanded — the concierge rail becomes the page. */}
          <Route path="/ask" element={null} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
