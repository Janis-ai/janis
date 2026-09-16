import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceUser } from '@janis/shared';
import { api, ApiError } from '../api/client';
import { useMe, useSavedReplies, useSlackChannels, useSlackStatus, useUsers } from '../api/hooks';
import { subscribeToPush, unsubscribeFromPush } from '../lib/push';

export default function Settings() {
  const { data: me } = useMe();
  const { data: users } = useUsers();
  const { data: slack } = useSlackStatus();
  const { data: slackChannels } = useSlackChannels(!!slack?.connected);
  const { data: savedReplies } = useSavedReplies();
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: '', name: '', password: '' });
  const [reply, setReply] = useState({ title: '', body: '' });
  const [error, setError] = useState('');
  const [pushMsg, setPushMsg] = useState('');
  const [slackMsg, setSlackMsg] = useState(
    new URLSearchParams(window.location.search).get('slack') === 'connected'
      ? 'Slack connected — pick an alert channel below.'
      : '',
  );

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

  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) =>
      api(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (e) => setError(e.message),
  });

  const removeUser = useMutation({
    mutationFn: (id: string) => api(`/api/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (e) => setError(e.message),
  });

  const setSlackChannel = useMutation({
    mutationFn: (channelId: string) =>
      api('/api/slack/channel', { method: 'PATCH', body: JSON.stringify({ channel_id: channelId }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['slackStatus'] }),
  });

  const testSlack = useMutation({
    mutationFn: () => api('/api/slack/test', { method: 'POST' }),
    onSuccess: () => setSlackMsg('Test message posted.'),
    onError: (e) => setSlackMsg(e.message),
  });

  const disconnectSlack = useMutation({
    mutationFn: () => api('/api/slack', { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['slackStatus'] });
      setSlackMsg('Slack disconnected.');
    },
  });

  const setNotify = useMutation({
    mutationFn: (notify: { push?: boolean; email?: boolean }) =>
      api<{ user: WorkspaceUser }>('/api/users/me', {
        method: 'PATCH',
        body: JSON.stringify({ notify }),
      }),
    onSuccess: (d) =>
      qc.setQueryData<{ user: WorkspaceUser; workspace: unknown }>(['me'], (old) =>
        old ? { ...old, user: d.user } : old,
      ),
  });

  const addReply = useMutation({
    mutationFn: (body: typeof reply) =>
      api('/api/saved-replies', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setReply({ title: '', body: '' });
      void qc.invalidateQueries({ queryKey: ['savedReplies'] });
    },
    onError: (e) => setError(e.message),
  });

  const removeReply = useMutation({
    mutationFn: (id: string) => api(`/api/saved-replies/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['savedReplies'] }),
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
        {me && (
          <div style={{ display: 'flex', gap: 18, marginTop: 12, fontSize: 14 }}>
            <label>
              <input
                type="checkbox"
                checked={me.user.notify?.push !== false}
                disabled={setNotify.isPending}
                onChange={(e) => setNotify.mutate({ push: e.target.checked })}
              />{' '}
              Web push
            </label>
            <label>
              <input
                type="checkbox"
                checked={me.user.notify?.email !== false}
                disabled={setNotify.isPending}
                onChange={(e) => setNotify.mutate({ email: e.target.checked })}
              />{' '}
              Email
            </label>
          </div>
        )}
      </div>

      <div className="card">
        <strong>Slack</strong>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          Alerts post to a Slack channel with Take over / Resume buttons; replying in the thread
          talks to the end user.
        </div>
        {slack?.connected ? (
          <>
            <div className="row">
              <select
                value={slack.alert_channel_id ?? ''}
                onChange={(e) => e.target.value && setSlackChannel.mutate(e.target.value)}
              >
                <option value="">Pick alert channel…</option>
                {slackChannels?.channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>#{ch.name}</option>
                ))}
              </select>
              <button className="btn" onClick={() => testSlack.mutate()}>Send test</button>
              <button className="btn danger" onClick={() => disconnectSlack.mutate()}>Disconnect</button>
            </div>
            {slackMsg && <div className="muted" style={{ marginTop: 8 }}>{slackMsg}</div>}
          </>
        ) : slack?.configured ? (
          <a className="btn primary" href="/api/slack/install">Connect Slack</a>
        ) : (
          <div className="muted">
            Set SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_SIGNING_SECRET on the API to enable
            the Slack app.
          </div>
        )}
      </div>

      <div className="card">
        <strong>Saved replies</strong>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          Canned responses — available in the composer via 📑.
        </div>
        {savedReplies?.saved_replies.map((r) => (
          <div key={r.id} className="row muted" style={{ marginTop: 8 }}>
            <span className="grow"><strong>{r.title}</strong> — {r.body.slice(0, 80)}</span>
            <button className="btn danger" onClick={() => removeReply.mutate(r.id)}>Delete</button>
          </div>
        ))}
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, maxWidth: 520 }}
          onSubmit={(e) => {
            e.preventDefault();
            addReply.mutate(reply);
          }}
        >
          <label>New saved reply</label>
          <input
            placeholder="title (e.g. refund-policy)"
            value={reply.title}
            onChange={(e) => setReply({ ...reply, title: e.target.value })}
            required
          />
          <textarea
            placeholder="reply text…"
            value={reply.body}
            onChange={(e) => setReply({ ...reply, body: e.target.value })}
            required
            rows={3}
          />
          <div>
            <button className="btn">Add</button>
          </div>
        </form>
      </div>

      <div className="card">
        <strong>Team</strong>
        {users?.users.map((u) => (
          <div key={u.id} className="row muted" style={{ marginTop: 8 }}>
            <span className="grow">{u.name} · {u.email}</span>
            {me?.user.role === 'admin' && u.id !== me.user.id ? (
              <>
                <select value={u.role} onChange={(e) => setRole.mutate({ id: u.id, role: e.target.value })}>
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
                <button className="btn danger" onClick={() => removeUser.mutate(u.id)}>Remove</button>
              </>
            ) : (
              <span className="badge active">{u.role}</span>
            )}
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
