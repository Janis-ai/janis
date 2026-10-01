import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceUser } from '@janis/shared';
import { api, ApiError } from '../api/client';
import { useMe, useSavedReplies, useSlackChannels, useSlackStatus, useUsers, type SlackInstallationInfo } from '../api/hooks';
import { getPushSubscription, subscribeToPush, unsubscribeFromPush, markPushDisabled, PUSH_CHANGE_EVENT } from '../lib/push';
import { installAvailable, isIOS, isStandalone, onInstallStateChange, promptInstall } from '../lib/install';
import { SlackChannelSelect } from '../components/SlackChannelSelect';
import { LlmEditor, type LlmBlock } from '../components/LlmEditor';
import { usePrompt, useConfirm } from '../components/Prompt';
import { CodeBlock } from '../components/bits';
import { currentTheme, setTheme } from '../lib/theme';
import { usePageTitle } from '../lib/title';

type Section = 'workspace' | 'me' | 'integrations' | 'deliverability' | 'team';
const SECTIONS: { key: Section; label: string }[] = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'me', label: 'Me' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'deliverability', label: 'Sending' },
  { key: 'team', label: 'Team' },
];

export default function Settings() {
  usePageTitle('Settings');
  const { data: me } = useMe();
  const [params, setParams] = useSearchParams();
  const section = (SECTIONS.some((s) => s.key === params.get('section'))
    ? params.get('section')
    : 'workspace') as Section;
  const { data: users } = useUsers();
  const { data: slack } = useSlackStatus();
  const { data: slackChannels } = useSlackChannels(!!slack?.connected);
  const { data: savedReplies } = useSavedReplies();
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: '', name: '', role: 'member' });
  const { data: providers } = useQuery({
    queryKey: ['auth-providers'],
    queryFn: () => api<{ google: boolean; slack: boolean; password: boolean }>('/auth/providers'),
    staleTime: Infinity,
  });
  const [reply, setReply] = useState({ title: '', body: '' });
  const [error, setError] = useState('');
  const [promptEl, ask] = usePrompt();
  const [confirmEl, confirm] = useConfirm();
  const [pushMsg, setPushMsg] = useState('');
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null);
  const [theme, setThemeState] = useState<'dark' | 'light'>(currentTheme());

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
    mutationFn: (body: { email: string; name?: string; role?: string }) =>
      api('/api/users', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setForm({ email: '', name: '', role: 'member' });
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

  const [wsName, setWsName] = useState('');
  const [wsNameMsg, setWsNameMsg] = useState('');
  const [hookUrl, setHookUrl] = useState('');
  const [hookMsg, setHookMsg] = useState('');
  const [helpDomain, setHelpDomain] = useState('');
  const [domainMsg, setDomainMsg] = useState('');
  const { data: workspaceDetail } = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      api<{
        workspace: { id: string; name: string; event_webhook_url: string | null; help_domain: string | null };
      }>('/api/workspace'),
  });
  useEffect(() => {
    const url = workspaceDetail?.workspace?.event_webhook_url;
    if (url !== undefined) setHookUrl(url ?? '');
    const domain = workspaceDetail?.workspace?.help_domain;
    if (domain !== undefined) setHelpDomain(domain ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceDetail?.workspace?.id]);
  const saveDomain = useMutation({
    mutationFn: (domain: string | null) =>
      api('/api/workspace', { method: 'PATCH', body: JSON.stringify({ help_domain: domain }) }),
    onSuccess: () => {
      setDomainMsg('Saved.');
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => setDomainMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  const saveHook = useMutation({
    mutationFn: (url: string | null) =>
      api('/api/workspace', { method: 'PATCH', body: JSON.stringify({ event_webhook_url: url }) }),
    onSuccess: () => {
      setHookMsg('Saved.');
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => setHookMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  const meWsId = me?.workspace?.id;
  useEffect(() => {
    if (meWsId) setWsName(me?.workspace?.name ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meWsId]);
  const renameWorkspace = useMutation({
    mutationFn: (name: string) =>
      api('/api/workspace', { method: 'PATCH', body: JSON.stringify({ name }) }),
    onSuccess: () => {
      setWsNameMsg('Workspace renamed.');
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => setWsNameMsg(e instanceof ApiError ? e.message : 'failed'),
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
    mutationFn: (notify: {
      push?: boolean;
      email?: boolean;
      sound?: boolean;
      events?: Record<string, boolean>;
    }) =>
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

  // Inline edit — Edit loads the reply into the form; the same fields PATCH.
  const [editReplyId, setEditReplyId] = useState<string | null>(null);
  const updateReply = useMutation({
    mutationFn: ({ id, ...b }: { id: string; title: string; body: string }) =>
      api(`/api/saved-replies/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    onSuccess: () => {
      setReply({ title: '', body: '' });
      setEditReplyId(null);
      void qc.invalidateQueries({ queryKey: ['savedReplies'] });
    },
    onError: (e) => setError(e.message),
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
      {promptEl}
      {confirmEl}
      <h1 className="page-title">Settings</h1>
      <div className="tabs" style={{ marginBottom: 12 }}>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            className={`tab${section === s.key ? ' active' : ''}`}
            onClick={() => setParams({ section: s.key })}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === 'workspace' && (
        <>
      <div className="card">
        <strong>Workspace</strong>
        {me?.user.role === 'admin' && me.workspace ? (
          <>
            <form
              className="row"
              style={{ marginTop: 6 }}
              onSubmit={(e) => {
                e.preventDefault();
                const name = wsName.trim();
                if (name && name !== me.workspace?.name) renameWorkspace.mutate(name);
              }}
            >
              <input
                style={{ maxWidth: 240 }}
                value={wsName}
                onChange={(e) => setWsName(e.target.value)}
                maxLength={120}
              />
              <button
                className="btn"
                disabled={
                  renameWorkspace.isPending ||
                  !wsName.trim() ||
                  wsName.trim() === me.workspace.name
                }
              >
                {renameWorkspace.isPending ? 'Saving…' : 'Rename'}
              </button>
            </form>
            {wsNameMsg && <div className="muted" style={{ marginTop: 8 }}>{wsNameMsg}</div>}
            <div className="form-field" style={{ marginTop: 12 }}>
              <label>
                Event webhook — POST every inbound message + handoff as JSON to a Zapier/Make catch hook
              </label>
              <div className="row">
                <input
                  className="grow"
                  style={{ maxWidth: 420 }}
                  placeholder="https://hooks.zapier.com/hooks/catch/…"
                  value={hookUrl}
                  onChange={(e) => setHookUrl(e.target.value)}
                />
                <button
                  className="btn"
                  disabled={saveHook.isPending}
                  onClick={() => saveHook.mutate(hookUrl.trim() || null)}
                >
                  {saveHook.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>
                {workspaceDetail?.workspace?.event_webhook_url ? 'Currently set — clear the field and save to remove.' : 'Not set.'}
                {' '}Blank disables the export. Pair with the "Webhook (Zapier / Make)" tool template for two-way automation.
              </span>
              {hookMsg && <div className="muted" style={{ marginTop: 6 }}>{hookMsg}</div>}
            </div>
            <div className="form-field" style={{ marginTop: 12 }}>
              <label>Help center domain — serve your help center at help.yourdomain.com</label>
              <div className="row">
                <input
                  className="grow"
                  style={{ maxWidth: 420 }}
                  placeholder="help.yourdomain.com"
                  value={helpDomain}
                  onChange={(e) => setHelpDomain(e.target.value)}
                />
                <button
                  className="btn"
                  disabled={saveDomain.isPending}
                  onClick={() => saveDomain.mutate(helpDomain.trim().toLowerCase() || null)}
                >
                  {saveDomain.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>
                {workspaceDetail?.workspace?.help_domain ? `Currently ${workspaceDetail.workspace.help_domain}.` : 'Not set.'}
                {' '}Point the domain's CNAME at {window.location.host} first, then set it here.
              </span>
              {domainMsg && <div className="muted" style={{ marginTop: 6 }}>{domainMsg}</div>}
            </div>
          </>
        ) : (
          <div className="muted" style={{ marginTop: 6 }}>{me?.workspace?.name}</div>
        )}
      </div>

      {me?.user.role === 'admin' && <DefaultLlmCard />}
        </>
      )}

      {section === 'deliverability' && (
        <>
      {me?.user.role === 'admin' && <SendPolicyCard />}
      {me?.user.role === 'admin' && <EventTokenCard />}
        </>
      )}

      {section === 'integrations' && me?.user.role === 'admin' && <CrmCard />}

      {section === 'me' && (
        <>
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={theme === 'light'}
            onChange={(e) => {
              const t = e.target.checked ? 'light' : 'dark';
              setTheme(t);
              setThemeState(t);
            }}
          />
          Light theme
          <span className="muted" style={{ fontSize: 12 }}>— for demos and daylight; dark stays default</span>
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
        {me && (
          <div style={{ marginTop: 14 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Notify me about
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
              {(
                [
                  ['handoff', 'Handoffs'],
                  ['assigned', 'Assigned to me'],
                  ['keyword', 'Keyword matches'],
                  ['approval', 'Approvals'],
                  ['digest', 'Digests'],
                  ['eval', 'Eval regressions'],
                  ['mention', 'Mentions'],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={(me.user.notify as { events?: Record<string, boolean> } | undefined)?.events?.[key] !== false}
                    disabled={setNotify.isPending}
                    onChange={(e) => setNotify.mutate({ events: { [key]: e.target.checked } })}
                  />{' '}
                  {label}
                </label>
              ))}
            </div>
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
        </>
      )}

      {section === 'integrations' && (
        <>
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
        </>
      )}

      {section === 'me' && (
      <div className="card">
        <strong>Saved replies</strong>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          Canned responses — available in the composer via 📑.
        </div>
        {savedReplies?.saved_replies.map((r) => (
          <div key={r.id} className="row muted" style={{ marginTop: 8 }}>
            <span className="grow"><strong>{r.title}</strong> — {r.body.slice(0, 80)}</span>
            <button
              className="btn ghost"
              onClick={() => {
                setEditReplyId(r.id);
                setReply({ title: r.title, body: r.body });
              }}
            >
              Edit
            </button>
            <button className="btn danger" onClick={() => removeReply.mutate(r.id)}>Delete</button>
          </div>
        ))}
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, maxWidth: 520 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (editReplyId) updateReply.mutate({ id: editReplyId, ...reply });
            else addReply.mutate(reply);
          }}
        >
          <label>{editReplyId ? 'Edit saved reply' : 'New saved reply'}</label>
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
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" disabled={addReply.isPending || updateReply.isPending}>
              {editReplyId ? 'Save changes' : 'Add'}
            </button>
            {editReplyId && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setEditReplyId(null);
                  setReply({ title: '', body: '' });
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
      )}

      {section === 'team' && (
        <>
      <div className="card">
        <strong>Team</strong>
        <div className="muted" style={{ margin: '6px 0 4px', fontSize: 13 }}>
          <strong>Admins</strong> manage agents, integrations, billing, and the team.{' '}
          <strong>Members</strong> work the inbox — reply, take over, assign, and set
          conversation status. The <strong>owner</strong> can't be removed — only they
          can hand ownership to another member.
        </div>
        {users?.users.map((u) => (
          <div key={u.id} className="row muted" style={{ marginTop: 8 }}>
            <span className="grow">
              {u.name} · {u.email}
              {u.status === 'invited' && (
                <span className="badge" style={{ marginLeft: 8 }}>invited</span>
              )}
            </span>
            {u.role === 'owner' ? (
              <span className="badge active">owner</span>
            ) : me?.user.role === 'admin' && u.id !== me.user.id ? (
              <>
                <select
                  value={u.role}
                  onChange={(e) => {
                    const role = e.target.value;
                    if (role !== 'owner') {
                      setRole.mutate({ id: u.id, role });
                      return;
                    }
                    void (async () => {
                      if (await confirm(`Transfer ownership of this workspace to ${u.name}? You stay an admin but lose ownership.`, undefined, true))
                        setRole.mutate({ id: u.id, role });
                    })();
                  }}
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                  <option value="viewer">viewer (read-only)</option>
                  {me.user.id === me.workspace?.owner_id && (
                    <option value="owner">owner (transfer)</option>
                  )}
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
                role: form.role,
              });
            }}
          >
            <label>Invite teammate</label>
            <div className="row">
              <input placeholder="name (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input placeholder="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="member">member</option>
                <option value="admin">admin</option>
                <option value="viewer">viewer (read-only)</option>
              </select>
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

      {me?.user.role === 'admin' && <AuditLogCard />}

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
            onClick={async () => {
              const name = await ask(
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

type SendPolicy = {
  quiet_enabled?: boolean;
  quiet_from?: string;
  quiet_to?: string;
  quiet_tz?: string;
  max_per_recipient_per_day?: number | null;
};
type SuppressionRow = { id: string; address: string; kind: string; reason: string; source: string | null };

/** Bulk-send guardrails — quiet hours + per-recipient cap + the workspace
 *  suppression list. Applies to campaigns/broadcasts only; replies aren't
 *  throttled. Admin-only. */
function SendPolicyCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      api<{ workspace: { send_policy?: SendPolicy | null } }>('/api/workspace'),
  });
  const { data: sup } = useQuery({
    queryKey: ['suppressions'],
    queryFn: () => api<{ suppressions: SuppressionRow[] }>('/api/suppressions'),
  });
  const saved = data?.workspace.send_policy ?? {};
  const [draft, setDraft] = useState<SendPolicy | null>(null);
  const [msg, setMsg] = useState('');
  const [newAddr, setNewAddr] = useState('');
  const [supQuery, setSupQuery] = useState('');
  const p = draft ?? saved;
  const dirty = draft !== null;
  const upd = (patch: Partial<SendPolicy>) => setDraft({ ...(draft ?? saved), ...patch });

  const save = useMutation({
    mutationFn: () =>
      api('/api/workspace', { method: 'PATCH', body: JSON.stringify({ send_policy: p }) }),
    onSuccess: () => {
      setDraft(null);
      setMsg('Saved — applies to the next queued send.');
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  const addSup = useMutation({
    mutationFn: () =>
      api('/api/suppressions', { method: 'POST', body: JSON.stringify({ address: newAddr }) }),
    onSuccess: () => {
      setNewAddr('');
      void qc.invalidateQueries({ queryKey: ['suppressions'] });
    },
  });
  const delSup = useMutation({
    mutationFn: (id: string) => api(`/api/suppressions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['suppressions'] }),
  });

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong>Sending rules</strong>
      <div className="muted" style={{ fontSize: 13 }}>
        Guardrails for campaign + broadcast sends — quiet hours, per-recipient
        caps, and the never-send list. Checked again at send time — queued
        sends honor changes.
      </div>
      <label className="row" style={{ gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={!!p.quiet_enabled}
          onChange={(e) => upd({ quiet_enabled: e.target.checked })}
        />
        Quiet hours — hold sends between
      </label>
      {p.quiet_enabled && (
        <div className="muted" style={{ fontSize: 12, marginLeft: 24, marginTop: -4 }}>
          Sends due inside the window wait and go out when it ends — they show as
          "held for quiet hours" on the campaign, never dropped.
        </div>
      )}
      {p.quiet_enabled && (
        <div className="row wrap" style={{ gap: 8, marginLeft: 24 }}>
          <input type="time" className="input" value={p.quiet_from ?? '21:00'}
            onChange={(e) => upd({ quiet_from: e.target.value })} />
          <span className="muted">to</span>
          <input type="time" className="input" value={p.quiet_to ?? '08:00'}
            onChange={(e) => upd({ quiet_to: e.target.value })} />
          <input className="input grow" style={{ maxWidth: 220 }}
            placeholder="Timezone (IANA), e.g. America/New_York"
            value={p.quiet_tz ?? ''} onChange={(e) => upd({ quiet_tz: e.target.value })} />
        </div>
      )}
      <label className="row" style={{ gap: 8, fontSize: 13 }}>
        Max sends per recipient / 24h:
        <input className="input" type="number" min="1" style={{ width: 80 }}
          placeholder="∞"
          value={p.max_per_recipient_per_day ?? ''}
          onChange={(e) =>
            upd({ max_per_recipient_per_day: e.target.value ? Number(e.target.value) : null })
          } />
      </label>
      <div className="row">
        <button className="btn primary" disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save policy'}
        </button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4 }}>
        <strong style={{ fontSize: 13 }}>Blocked senders</strong>
        <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
          Never-send addresses — bounces, complaints and dead numbers land here
          automatically. Sends to these show as "skipped — suppressed" on the
          campaign; removing an entry re-enables them.
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input className="input grow" style={{ maxWidth: 300 }}
            placeholder="email or phone to block…"
            value={newAddr} onChange={(e) => setNewAddr(e.target.value)} />
          <button className="btn" disabled={!newAddr.trim() || addSup.isPending}
            onClick={() => addSup.mutate()}>
            Block
          </button>
        </div>
        {(sup?.suppressions?.length ?? 0) > 0 && (
          <input
            placeholder="Search blocked senders…"
            value={supQuery}
            onChange={(e) => setSupQuery(e.target.value)}
            style={{ maxWidth: 280, marginTop: 8 }}
          />
        )}
        {(sup?.suppressions ?? [])
          .filter((s) =>
            supQuery
              ? s.address.toLowerCase().includes(supQuery.toLowerCase()) ||
                s.reason.toLowerCase().includes(supQuery.toLowerCase())
              : true,
          )
          .slice(0, 100)
          .map((s) => (
          <div key={s.id} className="row" style={{ fontSize: 13, padding: '3px 0' }}>
            <span className="mono grow">{s.address}</span>
            <span className="muted">{s.kind} · {s.reason}</span>
            <button className="btn ghost" onClick={() => delSup.mutate(s.id)}>Remove</button>
          </div>
        ))}
        {!!sup && sup.suppressions.length > 100 && !supQuery && (
          <div className="muted" style={{ fontSize: 12 }}>
            Showing first 100 of {sup.suppressions.length} — search to find a specific sender.
          </div>
        )}
        {!!sup && !sup.suppressions.length && (
          <div className="muted" style={{ fontSize: 12 }}>Empty — nobody is blocked.</div>
        )}
      </div>
    </div>
  );
}

/** Conversion-event ingestion — the token + endpoint CRM/marketing systems
 *  POST to when a contact converts. Attributes to the last campaign send. */
function EventTokenCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api<{ workspace: { event_token?: string | null } }>('/api/workspace'),
  });
  const [msg, setMsg] = useState('');
  const token = data?.workspace.event_token ?? null;
  const rotate = useMutation({
    mutationFn: () =>
      api<{ event_token: string }>('/api/workspace/event-token', { method: 'POST' }),
    onSuccess: () => {
      setMsg(token ? 'Rotated — update every integration using the old URL.' : 'Token minted.');
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  const url = token ? `${window.location.origin}/events/${token}` : '';
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong>Goal tracking</strong>
      <div className="muted" style={{ fontSize: 13 }}>
        Report business outcomes (purchase, signup, booked) from your systems —
        attributed to the contact's most recent campaign send so campaigns show
        real ROI.
      </div>
      {token ? (
        <CodeBlock
          title="Report a conversion"
          code={`curl -XPOST ${url} -H 'content-type: application/json' -d '{"event":"purchase","email":"who@co.com"}'`}
        />
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>No token yet — mint one to get the URL.</div>
      )}
      <div className="row">
        <button className="btn" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
          {token ? 'Rotate token' : 'Mint token'}
        </button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}

type CrmConn = {
  id: string;
  provider: string;
  enabled: boolean;
  activity_writeback: boolean;
  list_id: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  synced_count: number;
};

/** CRM sync — read-only pull from HubSpot into a synced contact list that
 *  campaigns can target. Consent flows one way (CRM → Janis), never clears
 *  a Janis opt-out. */
function CrmCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['crm'],
    queryFn: () => api<{ connections: CrmConn[] }>('/api/crm'),
    refetchInterval: 15_000,
  });
  const [provider, setProvider] = useState<'hubspot' | 'salesforce'>('hubspot');
  const [token, setToken] = useState('');
  const [sf, setSf] = useState({ host: '', client_id: '', client_secret: '' });
  const [msg, setMsg] = useState('');
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['crm'] });
  const connect = useMutation({
    mutationFn: () =>
      api('/api/crm', {
        method: 'POST',
        body: JSON.stringify(
          provider === 'hubspot'
            ? { provider, token: token.trim() }
            : { provider, ...sf },
        ),
      }),
    onSuccess: () => {
      setToken('');
      setSf({ host: '', client_id: '', client_secret: '' });
      setMsg('Connected — first sync is queued.');
      invalidate();
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  const syncNow = useMutation({
    mutationFn: (id: string) => api(`/api/crm/${id}/sync-now`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const writeback = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      api(`/api/crm/${id}`, { method: 'PATCH', body: JSON.stringify({ activity_writeback: on }) }),
    onSuccess: invalidate,
  });
  const toggleEnabled = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      api(`/api/crm/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: on }) }),
    onSuccess: invalidate,
  });
  const drop = useMutation({
    mutationFn: (id: string) => api(`/api/crm/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
  const conns = data?.connections ?? [];
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong>CRM sync</strong>
      <div className="muted" style={{ fontSize: 13 }}>
        Read-only pull — contacts sync into a "{`hubspot`} sync" list campaigns
        can target. Opt-outs import; Janis opt-outs are never cleared upstream.
      </div>
      {conns.map((cn) => (
        <div key={cn.id} className="row wrap" style={{ gap: 8, fontSize: 13 }}>
          <strong>{cn.provider}</strong>
          {!cn.enabled && <span className="badge warn">paused</span>}
          <span className="muted">
            {cn.synced_count} synced
            {cn.last_synced_at && ` · last ${new Date(cn.last_synced_at).toLocaleString()}`}
          </span>
          {cn.last_error && <span className="error" style={{ fontSize: 12 }}>{cn.last_error}</span>}
          <span className="grow" />
          <label className="row" style={{ gap: 5, fontSize: 12 }}>
            <input type="checkbox" checked={cn.enabled}
              onChange={(e) => toggleEnabled.mutate({ id: cn.id, on: e.target.checked })} />
            sync enabled
          </label>
          {cn.enabled && (
            <label className="row" style={{ gap: 5, fontSize: 12 }}>
              <input type="checkbox" checked={cn.activity_writeback}
                onChange={(e) => writeback.mutate({ id: cn.id, on: e.target.checked })} />
              log campaign activity on the CRM contact
            </label>
          )}
          <button className="btn ghost" onClick={() => syncNow.mutate(cn.id)}>Sync now</button>
          <button className="btn ghost" onClick={() => drop.mutate(cn.id)}>Disconnect</button>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <select className="input" value={provider}
          onChange={(e) => setProvider(e.target.value as 'hubspot' | 'salesforce')}>
          <option value="hubspot">HubSpot</option>
          <option value="salesforce">Salesforce</option>
        </select>
      </div>
      {provider === 'hubspot' ? (
        <div className="row" style={{ gap: 8 }}>
          <input className="input grow" style={{ maxWidth: 320 }} type="password"
            placeholder="HubSpot private-app token (pat-…)"
            value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn" disabled={!token.trim() || connect.isPending}
            onClick={() => connect.mutate()}>
            {connect.isPending ? 'Checking…' : 'Connect HubSpot'}
          </button>
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 8 }}>
            <input className="input grow" style={{ maxWidth: 320 }}
              placeholder="acme.my.salesforce.com"
              value={sf.host} onChange={(e) => setSf({ ...sf, host: e.target.value.trim() })} />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <input className="input grow" style={{ maxWidth: 320 }}
              placeholder="Connected app client id"
              value={sf.client_id} onChange={(e) => setSf({ ...sf, client_id: e.target.value.trim() })} />
            <input className="input grow" style={{ maxWidth: 320 }} type="password"
              placeholder="Client secret"
              value={sf.client_secret} onChange={(e) => setSf({ ...sf, client_secret: e.target.value })} />
            <button className="btn"
              disabled={!sf.host || !sf.client_id || !sf.client_secret || connect.isPending}
              onClick={() => connect.mutate()}>
              {connect.isPending ? 'Checking…' : 'Connect Salesforce'}
            </button>
          </div>
        </>
      )}
      {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
    </div>
  );
}

/** Audit trail — every security/billing-relevant mutation, newest first.
 *  Admin-only (the endpoint 403s members anyway). */
function AuditLogCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['audit-log'],
    queryFn: () =>
      api<{
        entries: {
          id: string;
          action: string;
          user_name: string | null;
          target_type: string | null;
          target_id: string | null;
          meta: Record<string, unknown>;
          created_at: string;
        }[];
      }>('/api/workspace/audit-log'),
    refetchInterval: 30_000,
  });
  const entries = data?.entries ?? [];
  return (
    <div className="card">
      <strong>Audit log</strong>
      <div className="muted" style={{ margin: '4px 0 10px' }}>
        Workspace mutations — who changed what, when.
      </div>
      {isLoading ? (
        <div className="muted">Loading…</div>
      ) : !entries.length ? (
        <div className="muted">Nothing recorded yet.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="muted">{new Date(e.created_at).toLocaleString()}</td>
                <td>{e.user_name ?? '—'}</td>
                <td>
                  <code>{e.action}</code>
                </td>
                <td className="muted">
                  {e.target_type ?? ''}
                  {e.target_id ? ` ${String(e.target_id).slice(0, 8)}` : ''}
                  {Object.keys(e.meta ?? {}).length
                    ? ` — ${Object.entries(e.meta)
                        .slice(0, 3)
                        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                        .join(', ')}`
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
          truncated={channels?.truncated}
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
