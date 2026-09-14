import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useMe, useUsers } from '../api/hooks';
import { subscribeToPush, unsubscribeFromPush } from '../lib/push';

export default function Settings() {
  const { data: me } = useMe();
  const { data: users } = useUsers();
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: '', name: '', password: '' });
  const [error, setError] = useState('');
  const [pushMsg, setPushMsg] = useState('');

  const addUser = useMutation({
    mutationFn: (body: typeof form) =>
      api('/api/users', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setForm({ email: '', name: '', password: '' });
      setError('');
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'failed'),
  });

  const togglePush = async () => {
    try {
      const ok = await subscribeToPush();
      setPushMsg(ok ? 'Push notifications enabled on this device.' : 'Push not configured (VAPID keys missing or unsupported).');
    } catch {
      setPushMsg('Could not enable push — check browser permission.');
    }
  };

  return (
    <>
      <h1 className="page-title">Settings</h1>

      <div className="card">
        <strong>Workspace</strong>
        <div className="muted" style={{ marginTop: 6 }}>{me?.workspace.name}</div>
      </div>

      <div className="card">
        <strong>Notifications</strong>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          Get pushed when an agent needs a human — works on mobile once installed as an app.
        </div>
        <div className="row">
          <button className="btn" onClick={() => void togglePush()}>Enable push</button>
          <button className="btn" onClick={() => void unsubscribeFromPush()}>Disable</button>
        </div>
        {pushMsg && <div className="muted" style={{ marginTop: 8 }}>{pushMsg}</div>}
      </div>

      <div className="card">
        <strong>Team</strong>
        {users?.users.map((u) => (
          <div key={u.id} className="row muted" style={{ marginTop: 8 }}>
            <span className="grow">{u.name} · {u.email}</span>
            <span className="badge active">{u.role}</span>
          </div>
        ))}

        {me?.user.role === 'admin' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addUser.mutate(form);
            }}
          >
            <label>Add teammate</label>
            <div className="row">
              <input placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              <input placeholder="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              <input placeholder="password (min 8)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
              <button className="btn">Add</button>
            </div>
          </form>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}
