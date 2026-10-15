import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceUser } from '@janis/shared';
import { api, ApiError } from '../api/client';
import { useMe, useSavedReplies, useSlackChannels, useSlackStatus, useUsers, type SlackInstallationInfo } from '../api/hooks';
import { getPushSubscription, subscribeToPush, unsubscribeFromPush, markPushDisabled, PUSH_CHANGE_EVENT } from '../lib/push';
import { installAvailable, isIOS, isStandalone, onInstallStateChange, promptInstall } from '../lib/install';
import { SlackChannelSelect } from '../components/SlackChannelSelect';
import { LlmEditor, type LlmBlock } from '../components/LlmEditor';
import { MemberGroups } from '../components/MemberGroups';
import { usePrompt, useConfirm } from '../components/Prompt';
import { Pencil, Trash2, X } from 'lucide-react';
import { NOTIFY_EVENT_LABELS } from '../lib/notifyEvents';
import { MemberCell, TeamRow, TeamTable, teamTd } from '../components/TeamTable';
import { AutosizeText } from '../components/bits';
import { currentTheme, setTheme } from '../lib/theme';
import { usePageTitle } from '../lib/title';

type Section = 'workspace' | 'me' | 'csat' | 'escalation' | 'team';
const SECTIONS: { key: Section; label: string }[] = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'me', label: 'Me' },

  { key: 'csat', label: 'CSAT' },
  { key: 'escalation', label: 'Escalation' },
  { key: 'team', label: 'Team' },
];

export default function Settings() {
  usePageTitle('Settings');
  const { data: me } = useMe();
  const [params, setParams] = useSearchParams();
  // 'deliverability' was the old "Sending" tab and 'experience' the old
  // label for what's now CSAT — both land on the resolution + survey
  // defaults; the campaign half moved to the Campaigns settings modal.
  const rawParam = params.get('section');
  const rawSection =
    rawParam === 'deliverability' || rawParam === 'experience' ? 'csat' : rawParam;
  const section = (SECTIONS.some((s) => s.key === rawSection)
    ? rawSection
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
  const [notifyFor, setNotifyFor] = useState<string | null>(null);
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
    onSuccess: (d) => {
      qc.setQueryData<{ user: WorkspaceUser; workspace: unknown }>(['me'], (old) =>
        old ? { ...old, user: d.user } : old,
      );
      // The editor renders notifyMember from ['users'] — a self-edit must
      // refresh it too or the selects snap back to the stale baseline.
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
  // Admin writes another member's workspace notification baseline via
  // PATCH /api/users/:id (notify is account-level — crosses workspaces).
  const setMemberNotify = useMutation({
    mutationFn: (vars: {
      id: string;
      notify: {
        push?: boolean;
        email?: boolean;
        sound?: boolean;
        events?: Record<string, boolean>;
      };
    }) =>
      api<{ user: WorkspaceUser }>(`/api/users/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ notify: vars.notify }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
  const notifyMember = notifyFor
    ? users?.users.find((u) => u.id === notifyFor) ?? null
    : null;
  const writeNotify = (id: string, notify: Parameters<typeof setNotify.mutate>[0]) =>
    id === me?.user.id
      ? setNotify.mutate(notify)
      : setMemberNotify.mutate({ id, notify });
  const notifying = setNotify.isPending || setMemberNotify.isPending;

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
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const uploadAvatar = async (file: File) => {
    setUploadingAvatar(true);
    setProfileMsg('Uploading…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'include' });
      if (res.ok) {
        const att = (await res.json()) as { url: string };
        // Sync local state — the preview renders profile.avatar_url, not
        // the ['me'] cache the PATCH updates.
        setProfile((p) => ({ ...p, avatar_url: att.url }));
        saveProfile.mutate({ avatar_url: att.url });
      } else {
        setProfileMsg('Upload failed.');
      }
    } finally {
      setUploadingAvatar(false);
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
  // Edit mode: gray out Save until the draft actually differs from stored.
  const replyUnchanged =
    !!editReplyId &&
    (() => {
      const t = savedReplies?.saved_replies.find((r) => r.id === editReplyId);
      return !!t && reply.title === t.title && reply.body === t.body;
    })();
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
                style={{ maxWidth: 340 }}
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
                  disabled={
                    saveHook.isPending ||
                    hookUrl.trim() === (workspaceDetail?.workspace?.event_webhook_url ?? '')
                  }
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
                  disabled={
                    saveDomain.isPending ||
                    helpDomain.trim().toLowerCase() ===
                      (workspaceDetail?.workspace?.help_domain ?? '')
                  }
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
      {me?.user.role === 'admin' && <CrmCard />}
      {me?.user.role === 'admin' && <RetentionCard />}
        </>
      )}

      {section === 'csat' && (
        <>
      {me?.user.role === 'admin' && <ResolutionCard />}
      {me?.user.role === 'admin' && <CsatCard />}
        </>
      )}

      {section === 'me' && (
        <>
      <div className="card">
        <strong>Appearance</strong>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 14 }}>
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

      {section === 'escalation' && (
        <>
      {me?.user.role === 'admin' && <HandoffCard />}
      <div className="card">
        <strong>Slack alerts</strong>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          Alerts post to a Slack channel with Take over / Resume buttons; replying in the thread
          talks to the end user. Agents can pick a different channel under
          Agent settings → Escalation.
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
        <strong>Profile</strong>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          Your customer-facing identity — the baseline every agent inherits.
          Shown to customers on channels that enable "show operator name"; agents
          can override it per-agent under Agent settings → Escalation. Leave the
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
          <button
            className="btn"
            disabled={
              saveProfile.isPending ||
              profile.display_name.trim() === (me?.user.display_name ?? '')
            }
          >
            Save
          </button>
          <span className="grow" />
          <label
            className="btn"
            style={{
              cursor: uploadingAvatar ? 'default' : 'pointer',
              opacity: uploadingAvatar ? 0.6 : 1,
            }}
          >
            {uploadingAvatar
              ? 'Uploading…'
              : profile.avatar_url
                ? 'Change avatar'
                : 'Upload avatar'}
            <input
              type="file"
              accept="image/*"
              hidden
              disabled={uploadingAvatar}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void uploadAvatar(f);
              }}
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
        <strong>Saved replies</strong>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          Canned responses — available in the composer via 📑 on every agent.
          Agents can add agent-scoped replies under Agent settings → Escalation.
        </div>
        {savedReplies?.saved_replies.filter((r) => !r.agent_id).map((r) => (
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
            <button
              className="btn"
              disabled={addReply.isPending || updateReply.isPending || replyUnchanged}
            >
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
        </>
      )}

      {section === 'team' && (
        <>
      <div className="card">
        <strong>Team</strong>
        <ul className="muted" style={{ margin: '6px 0 4px', paddingLeft: 18, fontSize: 13 }}>
          <li><strong>admin</strong> — manage agents, integrations, billing, and the team</li>
          <li><strong>member</strong> — work the inbox: reply, take over, assign, set status</li>
          <li><strong>viewer</strong> — read-only, no inbox actions</li>
          <li><strong>owner</strong> — can't be removed; transferable only by the owner</li>
        </ul>
        <TeamTable>
          {[...(users?.users ?? [])]
            .sort(
              (a, b) =>
                Number(b.id === me?.user.id) - Number(a.id === me?.user.id) ||
                a.name.localeCompare(b.name),
            )
            .map((u) => (
              <TeamRow key={u.id}>
                <MemberCell name={u.name} email={u.email} isYou={u.id === me?.user.id}>
                  {u.status === 'invited' && (
                    <span className="badge" style={{ marginLeft: 8 }}>invited</span>
                  )}
                </MemberCell>
                  <td style={teamTd}>
                    {(u.id === me?.user.id || me?.user.role === 'admin') && (
                      <button
                        className="btn ghost"
                        onClick={() => setNotifyFor(u.id)}
                        title="Workspace notification settings"
                        aria-label="Notification settings"
                      >
                        <Pencil size={14} />
                      </button>
                    )}
                  </td>
                  <td style={teamTd}>
                    {u.role === 'owner' ? (
                      <span className="badge active">owner</span>
                    ) : me?.user.role === 'admin' && u.id !== me.user.id ? (
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
                    ) : (
                      <span className="badge active">{u.role}</span>
                    )}
                  </td>
                  <td style={teamTd}>
                    {me?.user.role === 'admin' && u.id !== me.user.id && u.role !== 'owner' && (
                      <button
                        className="btn ghost"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => removeUser.mutate(u.id)}
                        title="Remove member"
                        aria-label="Remove member"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
              </TeamRow>
            ))}
        </TeamTable>

        {me?.user.role === 'admin' && (
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 18, paddingTop: 14 }}>
            <strong style={{ fontSize: 13 }}>Invite teammate</strong>
            <form
              className="row"
              style={{ marginTop: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                addUser.mutate({
                  email: form.email,
                  ...(form.name ? { name: form.name } : {}),
                  role: form.role,
                });
              }}
            >
              <input className="grow" placeholder="teammate@email.com" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              <input placeholder="name (optional)" style={{ width: 140 }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="member">member</option>
                <option value="admin">admin</option>
                <option value="viewer">viewer (read-only)</option>
              </select>
              <button className="btn">Invite</button>
            </form>
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              They sign in with Google or Slack using this email — the invite shows as an
              accept/decline banner when they land.
            </div>
            {error && <div className="error">{error}</div>}
          </div>
        )}
      </div>

      {notifyMember && me && (
        <div className="modal-backdrop" onClick={() => setNotifyFor(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            style={{ width: 680 }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setNotifyFor(null);
            }}
          >
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>Notifications — {notifyMember.name}</strong>
              <button className="btn ghost" onClick={() => setNotifyFor(null)} aria-label="Close">
                <X size={14} />
              </button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              {notifyMember.id === me.user.id ? 'Your' : "This member's"} workspace-wide
              baseline — applies on every agent unless overridden per-agent
              (Team tab → alerts).
            </div>
            {notifyMember.id === me.user.id && (
              <>
                <div className="row" style={{ marginTop: 12 }}>
                  <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>
                    Web push on this device:
                  </span>
                  {pushEnabled ? (
                    <>
                      <span style={{ fontSize: 13, alignSelf: 'center' }}>enabled</span>
                      <button className="btn" onClick={() => void disablePush()}>Disable</button>
                    </>
                  ) : (
                    <button className="btn" onClick={() => void togglePush()}>Enable push</button>
                  )}
                </div>
                {pushMsg && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{pushMsg}</div>}
              </>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              {([['push', 'Web push'], ['email', 'Email'], ['sound', 'Alert sounds']] as const).map(([k, label]) => (
                <span key={k} className="row" style={{ marginRight: 12, gap: 6 }}>
                  <span>{label}</span>
                  <select
                    value={notifyMember.notify?.[k] !== false ? 'on' : 'off'}
                    onChange={(e) => writeNotify(notifyMember.id, { [k]: e.target.value === 'on' })}
                    disabled={notifying}
                  >
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </span>
              ))}
            </div>
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
              <span className="muted" style={{ fontSize: 12 }}>Event types</span>
              <select
                value={(() => {
                  const vals = NOTIFY_EVENT_LABELS.map(([k]) => notifyMember.notify?.events?.[k]);
                  if (vals.every((v) => v === false)) return 'off';
                  if (vals.every((v) => v !== false)) return 'on';
                  return 'mixed';
                })()}
                onChange={(e) => {
                  const on = e.target.value === 'on';
                  const events: Record<string, boolean> = {};
                  for (const [k] of NOTIFY_EVENT_LABELS) events[k] = on;
                  writeNotify(notifyMember.id, { events });
                }}
                disabled={notifying}
              >
                {NOTIFY_EVENT_LABELS.some(([k]) => notifyMember.notify?.events?.[k] === false) &&
                  NOTIFY_EVENT_LABELS.some(([k]) => notifyMember.notify?.events?.[k] !== false) && (
                    <option value="mixed" disabled>mixed — set all:</option>
                  )}
                <option value="on">All on</option>
                <option value="off">All off</option>
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '4px 12px', fontSize: 13, marginTop: 6 }}>
              {NOTIFY_EVENT_LABELS.map(([key, label]) => (
                <div key={key} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{label}</span>
                  <select
                    value={notifyMember.notify?.events?.[key] !== false ? 'on' : 'off'}
                    onChange={(e) =>
                      writeNotify(notifyMember.id, { events: { [key]: e.target.value === 'on' } })
                    }
                    disabled={notifying}
                  >
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <GroupsCard isAdmin={me?.user.role === 'admin'} />

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

type CsatSettings = { enabled?: boolean; prompt?: string; thanks?: string };

/** Workspace data retention — conversations idle longer than the policy are
 *  permanently deleted (transcripts carry customer PII). The card shows the
 *  current blast radius so the merchant sees what changes before saving.
 *  Admin-only. */
const RETENTION_OPTIONS: { days: number | null; label: string }[] = [
  { days: null, label: 'Keep forever' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: '1 year' },
  { days: 730, label: '2 years' },
];

function RetentionCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      api<{
        workspace: {
          data_retention_days?: number | null;
          retention_expiring_count?: number | null;
        };
      }>('/api/workspace'),
  });
  const saved = data?.workspace.data_retention_days ?? null;
  const [draft, setDraft] = useState<number | null | undefined>(undefined);
  const [msg, setMsg] = useState('');
  const selected = draft === undefined ? saved : draft;
  const dirty = selected !== saved;
  const save = useMutation({
    mutationFn: () =>
      api('/api/workspace', {
        method: 'PATCH',
        body: JSON.stringify({ data_retention_days: selected }),
      }),
    onSuccess: () => {
      setDraft(undefined);
      setMsg('Saved — expired conversations are deleted within a minute of the sweep.');
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  const expiring = data?.workspace.retention_expiring_count;
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong>Conversation data retention</strong>
      <div className="muted" style={{ fontSize: 13 }}>
        Transcripts carry your customers' personal data — automatically delete
        conversations that have been idle longer than the period you choose.
        Deletion is permanent and applies to every agent in this workspace.
      </div>
      <div className="row" style={{ gap: 8 }}>
        <select
          value={selected === null ? 'forever' : String(selected)}
          onChange={(e) =>
            setDraft(e.target.value === 'forever' ? null : Number(e.target.value))
          }
        >
          {RETENTION_OPTIONS.map((o) => (
            <option key={o.label} value={o.days === null ? 'forever' : String(o.days)}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          className="btn primary"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {saved !== null && expiring !== null && expiring !== undefined && (
        <div className="muted" style={{ fontSize: 12 }}>
          {expiring === 0
            ? 'No conversations are currently past the retention period.'
            : `${expiring} conversation${expiring === 1 ? '' : 's'} older than ${saved} days will be deleted.`}
        </div>
      )}
      {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
    </div>
  );
}

/** Workspace default for human escalation — off steers every agent away
 *  from offering or requesting a human (they resolve what they can and say
 *  so when they can't). For workspaces that can't staff takeover. Agents
 *  can override under Agent settings → Escalation. Admin-only. */
function HandoffCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      api<{ workspace: { handoff_enabled?: boolean | null } }>('/api/workspace'),
  });
  const saved = data?.workspace.handoff_enabled !== false;
  const [draft, setDraft] = useState<boolean | null>(null);
  const [msg, setMsg] = useState('');
  const on = draft ?? saved;
  const save = useMutation({
    mutationFn: () =>
      api('/api/workspace', {
        method: 'PATCH',
        body: JSON.stringify({ handoff_enabled: on }),
      }),
    onSuccess: () => {
      setDraft(null);
      setMsg('Saved — applies to agents without their own override.');
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong>Human takeover</strong>
      <div className="muted" style={{ fontSize: 13 }}>
        When on, agents can offer or escalate to a human teammate when a
        customer asks or gets stuck. Turn off for workspaces that can't staff
        takeovers — agents then resolve what they can and say so plainly when
        they can't, never promising a human. Agents can override this under
        Agent settings → Escalation.
      </div>
      <label className="row" style={{ gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setDraft(e.target.checked)}
        />
        Agents can hand off to a human
      </label>
      <div className="row">
        <button
          className="btn primary"
          disabled={draft === null || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}

/** Workspace default for the resolution flow — when on, agents sign off and
 *  auto-archive once the customer confirms they're done (which fires the
 *  survey below). Agents override under Agent settings → CSAT.
 *  Admin-only. */
function ResolutionCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      api<{ workspace: { auto_archive?: boolean | null } }>('/api/workspace'),
  });
  const saved = data?.workspace.auto_archive === true;
  const [draft, setDraft] = useState<boolean | null>(null);
  const [msg, setMsg] = useState('');
  const on = draft ?? saved;
  const save = useMutation({
    mutationFn: () =>
      api('/api/workspace', {
        method: 'PATCH',
        body: JSON.stringify({ auto_archive: on }),
      }),
    onSuccess: () => {
      setDraft(null);
      setMsg('Saved — applies to agents without their own override.');
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong>Resolution</strong>
      <div className="muted" style={{ fontSize: 13 }}>
        When a customer confirms they're done, the agent signs off and
        archives the thread — firing the satisfaction survey below. Agents
        can override this under Agent settings → CSAT.
      </div>
      <label className="row" style={{ gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setDraft(e.target.checked)}
        />
        Auto-archive resolved chats
      </label>
      <div className="row">
        <button
          className="btn primary"
          disabled={draft === null || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}

/** Workspace default CSAT survey — fires when a conversation is archived.
 *  Agents override per-field via Agent settings → CSAT.
 *  Admin-only. */
function CsatCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['workspace'],
    queryFn: () =>
      api<{ workspace: { csat?: CsatSettings | null } }>('/api/workspace'),
  });
  const saved = data?.workspace.csat ?? {};
  const [draft, setDraft] = useState<CsatSettings | null>(null);
  const [msg, setMsg] = useState('');
  const c = draft ?? saved;
  const dirty = draft !== null;
  const upd = (patch: Partial<CsatSettings>) => setDraft({ ...(draft ?? saved), ...patch });
  const save = useMutation({
    mutationFn: () =>
      api('/api/workspace', { method: 'PATCH', body: JSON.stringify({ csat: c }) }),
    onSuccess: () => {
      setDraft(null);
      setMsg('Saved — applies to the next archived conversation.');
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'failed'),
  });
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong>Satisfaction survey</strong>
      <div className="muted" style={{ fontSize: 13 }}>
        Sent to the customer when a conversation is archived — they reply with a
        1–5 rating, scored in Reports. Agents can override per-field under
        Agent settings → CSAT.
      </div>
      <label className="row" style={{ gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={c.enabled ?? true}
          onChange={(e) => upd({ enabled: e.target.checked })}
        />
        Ask for a rating when a conversation is archived
      </label>
      <div className="form-field">
        <label>Survey question</label>
        <AutosizeText
          value={c.prompt ?? ''}
          placeholder="How was your experience? Reply with a rating from 1 (poor) to 5 (great)."
          onChange={(v) => upd({ prompt: v || undefined })}
        />
      </div>
      <div className="form-field">
        <label>Thank-you reply</label>
        <AutosizeText
          value={c.thanks ?? ''}
          placeholder="Thanks for the feedback!"
          onChange={(v) => upd({ thanks: v || undefined })}
        />
      </div>
      <div className="row">
        <button className="btn primary" disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save survey'}
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
 *  Admin-only (the endpoint 403s members anyway). Collapsed by default —
 *  it's a record you consult, not a surface you scan. */
const AUDIT_ACTIONS: Record<string, string> = {
  'agent.create': 'Created agent',
  'agent.delete': 'Deleted agent',
  'agent.config.update': 'Updated agent',
  'agent.knowledge.add': 'Added knowledge',
  'agent.rule.add': 'Added alert rule',
  'agent.widget.save': 'Saved widget config',
  'channel.create': 'Created channel',
  'channel.update': 'Updated channel',
  'channel.delete': 'Deleted channel',
  'channel.send': 'Sent channel message',
  'channel.broadcast': 'Broadcast to channel',
  'campaign.create': 'Created campaign',
  'campaign.send': 'Sent campaign',
  'campaign.delete': 'Deleted campaign',
  'contact.delete': 'Deleted contact',
  'contact.export': 'Exported contacts',
  'contact.merge': 'Merged contacts',
  'conversation.assign': 'Assigned conversation',
  'crm.connect': 'Connected CRM',
  'crm.disconnect': 'Disconnected CRM',
  'member.invite': 'Invited member',
  'list.create': 'Created list',
  'list.delete': 'Deleted list',
  'list.import': 'Imported list',
  'suppression.add': 'Added suppression',
  'suppression.remove': 'Removed suppression',
  'billing.checkout': 'Started checkout',
  'billing.downgrade': 'Downgraded plan',
  'billing.connect': 'Connected agency billing',
  'billing.agency_pricing': 'Updated agency pricing',
  'workspace.update': 'Updated workspace',
  'workspace.event_token.rotate': 'Rotated event token',
  'webhook.replay': 'Replayed webhook',
  'scim.sync': 'SCIM sync',
};

/** ids and raw payloads don't help a human read the row — the interesting
 *  meta is name/via/fields/entries. */
const AUDIT_META_SKIP = new Set([
  'id', 'target_id', 'agent_id', 'workspace_id', 'user_id', 'channel_id',
  'conversation_id', 'member_id', 'name',
]);
function auditTarget(
  targetType: string | null,
  meta: Record<string, unknown>,
): string {
  const name = typeof meta.name === 'string' ? meta.name : null;
  const bits = Object.entries(meta)
    .filter(([k]) => !AUDIT_META_SKIP.has(k))
    .slice(0, 3)
    .map(([k, v]) => {
      if (k === 'via' && v === 'concierge') return 'via Janis';
      const val = Array.isArray(v)
        ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ')
        : typeof v === 'object' && v !== null
          ? JSON.stringify(v)
          : String(v);
      return `${k}: ${val}`;
    });
  return [
    name ?? targetType ?? '',
    name && targetType ? `(${targetType})` : '',
    ...bits,
  ]
    .filter(Boolean)
    .join(' · ');
}

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
  const fmtWhen = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
      hour: 'numeric',
      minute: '2-digit',
    });
  };
  return (
    <div className="card">
      <details className="webhook-details" style={{ marginTop: 0 }}>
        <summary>
          <span className="details-title">Audit log</span>
          <span className="details-sub">
            workspace mutations — who changed what, when
            {entries.length ? ` · ${entries.length}` : ''}
          </span>
        </summary>
        {isLoading ? (
          <div className="muted" style={{ marginTop: 8 }}>Loading…</div>
        ) : !entries.length ? (
          <div className="muted" style={{ marginTop: 8 }}>Nothing recorded yet.</div>
        ) : (
          <table className="data-table" style={{ marginTop: 8 }}>
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
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                    {fmtWhen(e.created_at)}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{e.user_name ?? '—'}</td>
                  <td>{AUDIT_ACTIONS[e.action] ?? <code>{e.action}</code>}</td>
                  <td className="muted">{auditTarget(e.target_type, e.meta ?? {})}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
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

/** Settings → Team: workspace-wide named rosters. Agent-scoped groups live
 *  on each agent's Team tab — both render the shared MemberGroups editor. */
function GroupsCard({ isAdmin }: { isAdmin: boolean }) {
  const { data: users } = useUsers();
  const roster = (users?.users ?? []).map((u) => ({ id: u.id, name: u.name }));
  return <MemberGroups roster={roster} canManage={isAdmin} />;
}
