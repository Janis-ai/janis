import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ApiError } from './api/client';
import { useMe } from './api/hooks';
import Layout from './components/Layout';
import Login from './pages/Login';
import Inbox from './pages/Inbox';
import Channels from './pages/Channels';
import ConversationPage from './pages/ConversationPage';
import Agents from './pages/Agents';
import Reports from './pages/Reports';
import Integrations from './pages/Integrations';
import Settings from './pages/Settings';

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
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Inbox />} />
          <Route path="/channels" element={<Channels />} />
          <Route path="/conversations/:id" element={<ConversationPage />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
