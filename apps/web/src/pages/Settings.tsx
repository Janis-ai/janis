import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceUser } from '@janis/shared';
import { api, ApiError } from '../api/client';
import { useMe, useSavedReplies, useSlackChannels, useSlackStatus, useUsers, type SlackInstallationInfo } from '../api/hooks';
import { getPushSubscription, subscribeToPush, unsubscribeFromPush, markPushDisabled, PUSH_CHANGE_EVENT } from '../lib/push';
import { installAvailable, isIOS, isStandalone, onInstallStateChange, promptInstall } from '../lib/install';
import { SlackChannelSelect } from '../components/SlackChannelSelect';
import { LlmEditor, type LlmBlock } from '../components/LlmEditor';

export default function Settings() {
  const { data: me } = useMe();
  const { data: users } = useUsers();
  const { data: slack } = useSlackStatus();
  const { data: slackChannels } = useSlackChannels(!!slack?.connected);
  const { data: savedReplies } = useSavedReplies();
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: '', name: '' });
  const { data: providers } = useQuery({
    queryKey: ['auth-providers'],
    queryFn: () => api<{ google: boolean; slack: boolean; password: boolean }>('/auth/providers'),
    staleTime: Infinity,
  });
  const [reply, setReply] = useState({ title: '', body: '' });
  const [error, setError] = useState('');
  const [pushMsg, setPushMsg] = useState('');
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    const refresh = () =>
      void getPushSubscription()
        .then((sub) => setPushEnabled(!!sub))
        .catch(() => setPushEnabled(false));
    refresh();
    // Re-sync when push is toggled from elsewhere in this tab (e.g. the
    // activate banner) — the banner fires janis-push-change.
    window.addEventListener(PUSH_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(PUSH_CHANGE_EVENT, refresh);
  }, []);
  const [slackMsg, setSlackMsg] = useState(
    new URLSearchParams(window.location.search).get('slack') === 'connected'
      ? 'Slack connected — pick an alert channel below.'
      : '',
  );
  const [alertChannelName, setAlertChannelName] = useState('janis-alerts');

  const addUser = useMutation({
    mutationFn: (body: { email: string; name?: string }) =>
      api('/api/users', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setForm({ email: '', name: '' });
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
    mutationFn: ({ installation_id, channel_id }: { installation_id: string; channel_id: string }) =>
      api('/api/slack/channel', {
        method: 'PATCH',
        body: JSON.stringify({ installation_id, channel_id }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['slackStatus'] }),
  });
  const createChannel = useMutation({
    mutationFn: (vars: { name: string; installation_id?: string }) =>
      api<{ channel: { id: string; name: string } }>('/api/slack/channel', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: (res, vars) => {
      // Select the new channel immediately — Slack's conversations.list can
      // lag on freshly created channels, so don't wait for the refetch to
      // show it picked (that lag is what made "create & use" look broken).
      qc.setQueryData<{ channels: { id: string; name: string }[] }>(
        ['slackChannels', vars.installation_id ?? ''],
        (old) => ({
          channels: old?.channels.some((ch) => ch.id === res.channel.id)
            ? old.channels
            : [...(old?.channels ?? []), res.channel],
        }),
      );
      void qc.invalidateQueries({ queryKey: ['slackStatus'] });
      void qc.invalidateQueries({ queryKey: ['slackChannels'] });
      setSlackMsg(`Created #${res.channel.name} — alerts now post there.`);
    },
    onError: (e) => setSlackMsg(e.message),
  });

  const testSlack = useMutation({
    mutationFn: (installation_id: string) =>
      api(`/api/slack/test?installation_id=${installation_id}`, { method: 'POST' }),
    onSuccess: () => setSlackMsg('Test message posted.'),
    onError: (e) => setSlackMsg(e.message),
  });

  const disconnectSlack = useMutation({
    mutationFn: (installationId: string) =>
      api(`/api/slack/${installationId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['slackStatus'] });
      setSlackMsg('Slack workspace disconnected.');
    },
  });

  const deleteWorkspace = useMutation({
    mutationFn: () => api('/api/workspace', { method: 'DELETE' }),
    onSuccess: () => {
      window.location.href = '/';
    },
    onError: (e) => setError(e.message),
  });

  const setPassword = useMutation({
    mutationFn: (body: { current?: string; new: string }) =>
      api('/api/users/me', { method: 'PATCH', body: JSON.stringify({ password: body }) }),
    onSuccess: () => {
      setPw({ current: '', next: '' });
      setPwMsg('Password updated.');
    },
    onError: (e) => setPwMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwMsg, setPwMsg] = useState('');

  const setNotify = useMutation({
    mutationFn: (notify: { push?: boolean; email?: boolean; sound?: boolean }) =>
      api<{ user: WorkspaceUser }>('/api/users/me', {
        method: 'PATCH',
        body: JSON.stringify({ notify }),
      }),
    onSuccess: (d) =>
      qc.setQueryData<{ user: WorkspaceUser; workspace: unknown }>(['me'], (old) =>
        old ? { ...old, user: d.user } : old,
      ),
  });

  // Operator identity shown to customers on channels with "show operator
  // name" enabled — display name defaults to the first name when blank.
  const [profile, setProfile] = useState({ display_name: '', avatar_url: '' });
  const [profileMsg, setProfileMsg] = useState('');
  const meId = me?.user.id;
  useEffect(() => {
    if (meId) {
      setProfile({
        display_name: me?.user.display_name ?? '',
        avatar_url: me?.user.avatar_url ?? '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meId]);
  const saveProfile = useMutation({
    mutationFn: (body: { display_name?: string | null; avatar_url?: string | null; show_identity?: boolean }) =>
      api<{ user: WorkspaceUser }>('/api/users/me', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (d) => {
      qc.setQueryData<{ user: WorkspaceUser; workspace: unknown }>(['me'], (old) =>
        old ? { ...old, user: d.user } : old,
      );
      setProfileMsg('Profile saved.');
    },
    onError: (e) => setProfileMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  const uploadAvatar = async (file: File) => {
    setProfileMsg('Uploading…');
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'include' });
    if (res.ok) {
      const att = (await res.json()) as { url: string };
      saveProfile.mutate({ avatar_url: att.url });
    } else {
      setProfileMsg('Upload failed.');
    }
  };

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
      if (ok) setPushEnabled(true);
      setPushMsg(ok ? 'Push notifications enabled on this device.' : 'Push not configured (VAPID keys missing or unsupported).');
    } catch (err) {
      console.error('push subscribe failed:', err);
      const perm = 'Notification' in window ? Notification.permission : 'unavailable';
      setPushMsg(
        `Could not enable push — ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)} (permission: ${perm})`,
      );
    }
  };

  const disablePush = async () => {
    try {
      markPushDisabled(); // suppress the banner's auto re-subscribe on next load
      await unsubscribeFromPush();
      setPushEnabled(false);
      setPushMsg('Push disabled on this device.');
    } catch {
      setPushMsg('Could not disable push.');
    }
  };

  return (
    <>
      <h1 className="page-title">Settings</h1>

      <div className="card">
        <strong>Workspace</strong>
        <div className="muted" style={{ marginTop: 6 }}>{me?.workspace?.name}</div>
      </div>

      {me?.user.role === 'admin' && <DefaultLlmCard />}

      <div className="card">
        <strong>Profile</strong>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          Shown to customers on webchat channels that enable "show operator name". Leave the
          display name blank to use your first name ({me?.user.name.split(' ')[0] ?? '—'}).
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            saveProfile.mutate({ display_name: profile.display_name.trim() || null });
          }}
        >
          <input
            style={{ maxWidth: 240 }}
            placeholder={me?.user.name.split(' ')[0] ?? 'display name'}
            value={profile.display_name}
            onChange={(e) => setProfile({ ...profile, display_name: e.target.value })}
            maxLength={80}
          />
          <button className="btn" disabled={saveProfile.isPending}>Save</button>
          <span className="grow" />
          <label className="btn" style={{ cursor: 'pointer' }}>
            {profile.avatar_url ? 'Change avatar' : 'Upload avatar'}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => e.target.files?.[0] && void uploadAvatar(e.target.files[0])}
            />
          </label>
          {profile.avatar_url && (
            <>
              <img
                src={profile.avatar_url}
                alt="avatar"
                style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }}
              />
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  setProfile({ ...profile, avatar_url: '' });
                  saveProfile.mutate({ avatar_url: null });
                }}
              >
                Remove
              </button>
            </>
          )}
        </form>
        {profileMsg && <div className="muted" style={{ marginTop: 8 }}>{profileMsg}</div>}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={me?.user.show_identity !== false}
            disabled={saveProfile.isPending}
            onChange={(e) => saveProfile.mutate({ show_identity: e.target.checked })}
          />
          Show my name &amp; avatar to customers
          <span className="muted" style={{ fontSize: 12 }}>
            — unchecked, your replies stay anonymous even on enabled channels
          </span>
        </label>
      </div>

      <div className="card">
        <strong>Notifications</strong>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          Get pushed when an agent needs a human — works on mobile once installed as an app.
        </div>
        <div className="row">
          {pushEnabled ? (
            <>
              <span className="muted" style={{ alignSelf: 'center' }}>Enabled on this device</span>
              <button className="btn" onClick={() => void disablePush()}>Disable</button>
            </>
          ) : (
            <button className="btn" onClick={() => void togglePush()}>Enable push</button>
          )}
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
            <label>
              <input
                type="checkbox"
                checked={me.user.notify?.sound !== false}
                disabled={setNotify.isPending}
                onChange={(e) => setNotify.mutate({ sound: e.target.checked })}
              />{' '}
              Alert sounds
            </label>
          </div>
        )}
      </div>

      {providers?.password && (
      <div className="card">
        <strong>Password</strong>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          Change the password you sign in with. If your account was created via Google/Slack
          sign-in, leave the current password blank to set your first one.
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            setPwMsg('');
            setPassword.mutate({
              ...(pw.current ? { current: pw.current } : {}),
              new: pw.next,
            });
          }}
        >
          <input
            type="password"
            placeholder="current password"
            autoComplete="current-password"
            value={pw.current}
            onChange={(e) => setPw({ ...pw, current: e.target.value })}
          />
          <input
            type="password"
            placeholder="new password (min 8)"
            autoComplete="new-password"
            minLength={8}
            required
            value={pw.next}
            onChange={(e) => setPw({ ...pw, next: e.target.value })}
          />
          <button className="btn" disabled={setPassword.isPending}>Change</button>
        </form>
        {pwMsg && <div className="muted" style={{ marginTop: 8 }}>{pwMsg}</div>}
      </div>
      )}

      <InstallCard />

      <div className="card">
        <strong>Slack</strong>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          Alerts post to a Slack channel with Take over / Resume buttons; replying in the thread
          talks to the end user.
        </div>
        {me?.user.role !== 'admin' ? (
          <div className="muted">
            {slack?.connected
              ? `Connected — alerts post to ${slackChannels?.channels.find((ch) => ch.id === slack.alert_channel_id)?.name ? `#${slackChannels.channels.find((ch) => ch.id === slack.alert_channel_id)!.name}` : 'the alert channel'}. Managed by admins.`
              : 'Not connected. Managed by workspace admins.'}
          </div>
        ) : slack?.connected ? (
          <>
            {(slack.installations ?? []).map((inst, i) => (
              <SlackInstallEditor
                key={inst.id}
                inst={inst}
                isDefault={i === 0}
                alertChannelName={alertChannelName}
                setAlertChannelName={setAlertChannelName}
                busy={setSlackChannel.isPending || createChannel.isPending}
                onPick={(channel_id) =>
                  setSlackChannel.mutate({ installation_id: inst.id, channel_id })
                }
                onCreate={async (name) => {
                  await createChannel.mutateAsync({ name, installation_id: inst.id });
                }}
                onTest={() => testSlack.mutate(inst.id)}
                onDisconnect={() => disconnectSlack.mutate(inst.id)}
              />
            ))}
            {slack.configured && (
              <div style={{ marginTop: 10 }}>
                <a className="btn" href="/api/slack/install">Connect another Slack workspace</a>
              </div>
            )}
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
        <div className="muted" style={{ margin: '6px 0 4px', fontSize: 13 }}>
          <strong>Admins</strong> manage agents, integrations, billing, and the team.{' '}
          <strong>Members</strong> work the inbox — reply, take over, assign, and set
          conversation status.
        </div>
        {users?.users.map((u) => (
          <div key={u.id} className="row muted" style={{ marginTop: 8 }}>
            <span className="grow">
              {u.name} · {u.email}
              {u.status === 'invited' && (
                <span className="badge" style={{ marginLeft: 8 }}>invited</span>
              )}
            </span>
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
              addUser.mutate({
                email: form.email,
                ...(form.name ? { name: form.name } : {}),
              });
            }}
          >
            <label>Invite teammate</label>
            <div className="row">
              <input placeholder="name (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input placeholder="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              <button className="btn">Invite</button>
            </div>
            <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
              They sign in with Google or Slack using this email — the invite shows as an
              accept/decline banner when they land.
            </div>
          </form>
        )}
        {error && <div className="error">{error}</div>}
      </div>

      {me?.user.role === 'admin' && (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <strong>Danger zone</strong>
          <div className="muted" style={{ margin: '6px 0 10px' }}>
            Permanently delete this workspace — every conversation, agent, channel, and teammate.
            Any active subscription is canceled. This cannot be undone.
          </div>
          <button
            className="btn danger"
            disabled={deleteWorkspace.isPending}
            onClick={() => {
              const name = window.prompt(
                `Type the workspace name (${me.workspace?.name}) to confirm deletion:`,
              );
              if (name === me.workspace?.name) deleteWorkspace.mutate();
              else if (name !== null) setError('Workspace name did not match — nothing deleted.');
            }}
          >
            {deleteWorkspace.isPending ? 'Deleting…' : 'Delete workspace'}
          </button>
        </div>
      )}
    </>
  );
}

/** The workspace default LLM — every hosted agent inherits it unless it
 *  sets its own override on the agent page. Admin only. */
function DefaultLlmCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      api<{ workspace: { id: string; name: string; llm_config?: LlmBlock } }>('/api/workspace'),
  });
  const saved = data?.workspace.llm_config;
  const [draft, setDraft] = useState<LlmBlock | null>(null);
  const [msg, setMsg] = useState('');
  const llm = draft ?? saved ?? {};

  const save = useMutation({
    mutationFn: (body: { llm_config: LlmBlock | null }) =>
      api('/api/workspace', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      setDraft(null);
      setMsg('Default LLM saved — agents without an override now use it.');
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'failed'),
  });

  const dirty = draft !== null;
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong>Default LLM</strong>
      <div className="muted" style={{ fontSize: 13 }}>
        The model and credentials hosted agents run on unless an agent sets its
        own override on its page.
      </div>
      <LlmEditor
        llm={llm}
        onChange={(l) => setDraft(l)}
        isAdmin
        modelsUrl="/api/workspace/llm-models"
        inheritedLabel="platform default"
      />
      <div className="row">
        <button
          className="btn primary"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate({ llm_config: llm })}
        >
          {save.isPending ? 'Saving…' : 'Save default'}
        </button>
        {Object.keys(saved ?? {}).length > 0 && (
          <button
            className="btn"
            disabled={save.isPending}
            onClick={() => save.mutate({ llm_config: null })}
          >
            Reset to platform default
          </button>
        )}
      </div>
      {msg && <div className="muted" style={{ fontSize: 12 }}>{msg}</div>}
    </div>
  );
}

/** Install-as-app card — hidden once installed; iOS shows the Safari steps. */
function InstallCard() {
  const [available, setAvailable] = useState(installAvailable());
  useEffect(() => onInstallStateChange(() => setAvailable(installAvailable())), []);
  const ios = isIOS();
  if (isStandalone() || (!available && !ios)) return null;
  return (
    <div className="card">
      <strong>Install the app</strong>
      {ios && !available ? (
        <div className="muted" style={{ marginTop: 6 }}>
          On iOS: open this page in <strong>Safari</strong>, tap <strong>Share</strong> →{' '}
          <strong>Add to Home Screen</strong>. Push notifications only work once installed.
        </div>
      ) : (
        <>
          <div className="muted" style={{ margin: '6px 0 10px' }}>
            Add Janis to your home screen or dock for one-tap access and push notifications.
          </div>
          <button className="btn" onClick={() => void promptInstall()}>Install Janis</button>
        </>
      )}
    </div>
  );
}

/** One connected Slack workspace: name, its alert channel picker, and
 * test/disconnect controls scoped to that installation. */
function SlackInstallEditor({
  inst,
  isDefault,
  alertChannelName,
  setAlertChannelName,
  busy,
  onPick,
  onCreate,
  onTest,
  onDisconnect,
}: {
  inst: SlackInstallationInfo;
  isDefault: boolean;
  alertChannelName: string;
  setAlertChannelName: (v: string) => void;
  busy: boolean;
  onPick: (channelId: string) => void;
  onCreate: (name: string) => Promise<void>;
  onTest: () => void;
  onDisconnect: () => void;
}) {
  const { data: channels } = useSlackChannels(true, inst.id);
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>{inst.team_name ?? inst.team_id}</strong>
        <span className="muted" style={{ fontSize: 12 }}>
          {isDefault ? 'default workspace' : ''}
        </span>
      </div>
      {!inst.alert_channel_id && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ marginBottom: 8 }}>
            No alert channel yet. Create a dedicated channel for Janis alerts —
            you can rename it:
          </div>
          <div className="row">
            <input
              style={{ width: 200 }}
              value={alertChannelName}
              onChange={(e) => setAlertChannelName(e.target.value)}
              placeholder="janis-alerts"
            />
            <button
              className="btn primary"
              disabled={!alertChannelName.trim() || busy}
              onClick={() => void onCreate(alertChannelName.trim())}
            >
              {busy ? 'Creating…' : 'Create channel'}
            </button>
            <span className="muted">or pick an existing channel below</span>
          </div>
        </div>
      )}
      <div className="row">
        <SlackChannelSelect
          channels={channels?.channels}
          value={inst.alert_channel_id ?? ''}
          busy={busy}
          onPick={(id) => id && onPick(id)}
          onCreate={onCreate}
        />
        <button className="btn" onClick={onTest}>Send test</button>
        <button className="btn danger" onClick={onDisconnect}>Disconnect</button>
      </div>
    </div>
  );
}
