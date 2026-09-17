import { Component, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ApiError } from './api/client';
import { useMe } from './api/hooks';
import Layout from './components/Layout';
import Login from './pages/Login';
import Landing from './pages/Landing';
import { Privacy, Terms } from './pages/Legal';
import Conversations from './pages/Conversations';
import ConversationPage from './pages/ConversationPage';
import Agents from './pages/Agents';
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
  const { data, isLoading, error } = useMe();
  if (isLoading) return <div className="login-wrap muted">Loading…</div>;
  if (error instanceof ApiError && error.status === 401) return <Navigate to="/login" replace />;
  if (error) return <div className="login-wrap error">{error.message}</div>;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
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
