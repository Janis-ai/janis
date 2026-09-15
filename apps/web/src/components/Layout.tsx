import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useMe } from '../api/hooks';
import { useStream } from '../lib/useStream';

export default function Layout() {
  const { data } = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  useStream(true);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    navigate('/login');
  };

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">Janis</div>
        <NavLink to="/" end><span className="label">Inbox</span><span className="icon">⬤</span></NavLink>
        <NavLink to="/channels"><span className="label">Channels</span><span className="icon">▤</span></NavLink>
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
    </div>
  );
}
