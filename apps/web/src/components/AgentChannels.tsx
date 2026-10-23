import { Fragment, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Agent, Channel } from '@janis/shared';
import { useChannels, useMe } from '../api/hooks';
import { Empty } from './bits';
import { KIND_LABEL, type PendingAssets } from './Channels';
import { useConfirm } from './Prompt';
import { friendlyError } from '../lib/friendlyError';

/**
 * Per-agent channel manager — everything the old workspace-wide /integrations
 * page did, scoped to one agent: Meta OAuth connect + asset picker, webchat,
 * email, Gmail and manual credentials, plus the channel cards themselves.
 */
export function AgentChannels({ agent }: { agent: Agent }) {
  const agentId = agent.id;
  const { data } = useChannels();
  const { data: me } = useMe();
  const isAdmin = me?.user.role === 'admin';
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const metaError = params.get('meta_error') ?? '';
  const gmailError = params.get('gmail_error') ?? '';
  const gmailConnected = params.get('gmail_connect') ?? '';
  const outlookError = params.get('outlook_error') ?? '';
  const outlookConnected = params.get('outlook_connect') ?? '';
  const cfError = params.get('cf_error') ?? '';
  const cfConnected = params.get('cf_connect') ?? '';
  const [showManual, setShowManual] = useState(false);
  const [error, setError] = useState('');
  // Same-origin deploys serve the API on the web origin; dev splits :5173/:8787.
  const apiOrigin =
    window.location.hostname === 'localhost' ? 'http://localhost:8787' : window.location.origin;

  // Clear only our params — keep ?tab=channels etc.
  const dropParams = (...keys: string[]) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const k of keys) next.delete(k);
        return next;
      },
      { replace: true },
    );

  const metaStatus = useQuery({
    queryKey: ['meta-status'],
    queryFn: () => api<{ configured: boolean }>('/api/meta/status'),
    staleTime: Infinity,
    enabled: isAdmin,
  });
  const session = useQuery({
    queryKey: ['meta-session'],
    queryFn: () =>
      api<{ connected: boolean; connect_id?: string; expired?: boolean }>('/api/meta/session'),
    staleTime: 60_000,
    enabled: isAdmin,
  });
  // The asset picker collapses to a summary row once set up — it only opens on
  // a fresh OAuth return (?meta_connect=) or an explicit Manage click, so a
  // long Page list doesn't bury the other channel cards.
  const [pickerOpen, setPickerOpen] = useState(Boolean(params.get('meta_connect')));
  // "Where do your customers reach you?" — picks the card that answers it.
  const [need, setNeed] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // The "your agent is live" banner acknowledges once per agent.
  const [launchAcked, setLaunchAcked] = useState(() => {
    try {
      return localStorage.getItem(`janis.launch-ack.${agentId}`) === '1';
    } catch {
      return true;
    }
  });
  const ackLaunch = () => {
    setLaunchAcked(true);
    try {
      localStorage.setItem(`janis.launch-ack.${agentId}`, '1');
    } catch {}
  };
  type ChKey = 'bubble' | 'meta' | 'gmail' | 'outlook' | 'email' | 'voice' | 'sms';
  const ALL_CH: ChKey[] = ['bubble', 'meta', 'gmail', 'outlook', 'email', 'voice', 'sms'];
  const NEED_TARGETS: Record<string, string> = {
    site: 'ch-bubble',
    social: 'ch-meta',
    email: 'ch-gmail',
    phone: 'ch-voice',
  };
  const NEED_TO_CH: Record<string, ChKey> = {
    site: 'bubble',
    social: 'meta',
    email: 'gmail',
    phone: 'voice',
  };
  const connectId =
    params.get('meta_connect') ?? (session.data?.connected ? session.data.connect_id ?? '' : '');
  const disconnect = useMutation({
    mutationFn: () => api('/api/meta/session', { method: 'DELETE' }),
    onSuccess: () => {
      dropParams('meta_connect');
      void qc.invalidateQueries({ queryKey: ['meta-session'] });
    },
    onError: (e) => setError(e.message),
  });
  const pending = useQuery({
    queryKey: ['meta-pending', connectId],
    queryFn: () => api<PendingAssets>(`/api/meta/pending?id=${connectId}`),
    // skip the Meta API call entirely while the picker is collapsed
    enabled: pickerOpen && Boolean(connectId),
    retry: false,
  });

  const link = useMutation({
    mutationFn: (body: { kind: string; page_id?: string; phone_number_id?: string; takeover?: boolean }) =>
      api<{ channel: Channel }>('/api/meta/link', {
        method: 'POST',
        body: JSON.stringify({ connect_id: connectId, agent_id: agentId, ...body }),
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['build-status'] });
      goToChannel(r.channel.id);
    },
    onError: (e) => setError(e.message),
  });

  // Deep link — ?channel=<id> opens that channel's settings page
  const navigate = useNavigate();
  // A new channel always has more to configure — webhook URL, embed snippet,
  // appearance, forwarding — so creation lands on its settings page.
  const goToChannel = (id: string) => navigate(`/agents/${agentId}/channels/${id}`);
  const focusChannel = params.get('channel');
  useEffect(() => {
    if (!focusChannel || !data) return;
    const ch = (data.channels ?? []).find((c) => c.id === focusChannel);
    if (!ch) return;
    dropParams('channel');
    navigate(`/agents/${ch.agent_id}/channels/${ch.id}`, { replace: true });
  }, [focusChannel, data]); // eslint-disable-line react-hooks/exhaustive-deps

  // OAuth returns land back here with ?gmail_connect= / ?outlook_connect= /
  // ?cf_connect= — refresh channel state once so new creds render.
  useEffect(() => {
    if (!gmailConnected && !outlookConnected && !cfConnected) return;
    void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['build-status'] });
  }, [gmailConnected, outlookConnected, cfConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  const [form, setForm] = useState({
    kind: 'messenger' as 'messenger' | 'instagram' | 'whatsapp',
    name: '',
    page_id: '',
    phone_number_id: '',
    access_token: '',
  });
  const create = useMutation({
    mutationFn: () =>
      api<{ channel: Channel }>('/api/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: form.kind,
          name: form.name,
          agent_id: agentId,
          page_id: form.page_id || undefined,
          phone_number_id: form.phone_number_id || undefined,
          access_token: form.access_token,
        }),
      }),
    onSuccess: (r) => {
      setForm({ ...form, name: '', page_id: '', phone_number_id: '', access_token: '' });
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['build-status'] });
      goToChannel(r.channel.id);
    },
    onError: (e) => setError(e.message),
  });

  // Web chat widget — no credentials needed; name/greeting/replies are
  // edited on the channel card after creation.
  const createWebchat = useMutation({
    mutationFn: () =>
      api<{ channel: Channel }>('/api/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'webchat',
          name: agent.name,
          agent_id: agentId,
        }),
      }),
    onSuccess: (r) => {
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['build-status'] });
      goToChannel(r.channel.id);
    },
    onError: (e) => setError(e.message),
  });

  // Email channel — the address is minted server-side; the settings page
  // it lands on shows the address and MX instructions.
  const createEmail = useMutation({
    mutationFn: () =>
      api<{ channel: Channel }>('/api/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'email',
          name: `${agent.name} email`,
          agent_id: agentId,
        }),
      }),
    onSuccess: (r) => {
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['build-status'] });
      goToChannel(r.channel.id);
    },
    onError: (e) => setError(e.message),
  });

  // Gmail — OAuth round-trip creates the channel; the name defaults to the
  // mailbox address and is renamed on the channel card.
  const [gmLink, setGmLink] = useState('');
  const gmInvite = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/api/gmail/connect-link?agent_id=${agentId}`),
    onSuccess: async (r) => {
      setGmLink(r.url);
      try {
        await navigator.clipboard.writeText(r.url);
      } catch {}
    },
  });

  // Outlook — same mailbox-owner link model as Gmail.
  const [olLink, setOlLink] = useState('');
  const olInvite = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/api/outlook/connect-link?agent_id=${agentId}`),
    onSuccess: async (r) => {
      setOlLink(r.url);
      try {
        await navigator.clipboard.writeText(r.url);
      } catch {}
    },
  });

  // Voice — Janis-hosted number (search + pick) or bring-your-own Twilio
  // creds; the webhook URL lives on the channel card.
  const [voiceMode, setVoiceMode] = useState<'hosted' | 'byo'>('hosted');
  const [areaCode, setAreaCode] = useState('');
  const [foundNumbers, setFoundNumbers] = useState<
    { phone_number: string; friendly_name: string; locality?: string; region?: string }[] | null
  >(null);
  const [hostedConfigured, setHostedConfigured] = useState(true);
  const [pickedNumber, setPickedNumber] = useState('');
  const [voiceForm, setVoiceForm] = useState({
    sid: '',
    token: '',
    number: '',
    forward_to: '',
    greeting: '',
  });
  const searchNumbers = useMutation({
    mutationFn: () =>
      api<{ configured: boolean; paid: boolean; numbers: typeof foundNumbers }>(
        `/api/channels/voice-numbers?area_code=${encodeURIComponent(areaCode)}`,
      ),
    onSuccess: (r) => {
      if (!r.configured) {
        setHostedConfigured(false);
        setVoiceMode('byo');
        setError('Hosted numbers are not enabled on this deployment — use your own Twilio creds.');
        return;
      }
      if (r.paid === false) {
        setFoundNumbers([]);
        setError('Hosted numbers need a paid plan — upgrade on the Billing page, or use your own Twilio creds below.');
        return;
      }
      setFoundNumbers(r.numbers);
      setPickedNumber(r.numbers?.[0]?.phone_number ?? '');
      setError('');
    },
    onError: (e) => setError(e.message),
  });
  const createVoice = useMutation({
    mutationFn: () =>
      api<{ channel: Channel }>('/api/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'voice',
          name: `${agent.name} voice`,
          agent_id: agentId,
          ...(voiceMode === 'hosted'
            ? { hosted: true, phone_number: pickedNumber }
            : {
                twilio_account_sid: voiceForm.sid,
                twilio_auth_token: voiceForm.token,
                phone_number: voiceForm.number,
              }),
          forward_to: voiceForm.forward_to || undefined,
          greeting: voiceForm.greeting || undefined,
        }),
      }),
    onSuccess: (r) => {
      setVoiceForm({ sid: '', token: '', number: '', forward_to: '', greeting: '' });
      setFoundNumbers(null);
      setPickedNumber('');
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['build-status'] });
      goToChannel(r.channel.id);
    },
    onError: (e) => setError(e.message),
  });

  // SMS — clone a voice channel's number/creds (from_voice_channel_id), or
  // BYO Twilio account sid + token + SMS-capable number.
  const [smsForm, setSmsForm] = useState({ sid: '', token: '', number: '' });
  const createSms = useMutation({
    mutationFn: (fromVoiceId?: string) =>
      api<{ channel: Channel }>('/api/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'sms',
          name: `${agent.name} SMS`,
          agent_id: agentId,
          ...(fromVoiceId
            ? { from_voice_channel_id: fromVoiceId }
            : {
                twilio_account_sid: smsForm.sid,
                twilio_auth_token: smsForm.token,
                phone_number: smsForm.number,
              }),
        }),
      }),
    onSuccess: (r) => {
      setSmsForm({ sid: '', token: '', number: '' });
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['build-status'] });
      goToChannel(r.channel.id);
    },
    onError: (e) => setError(e.message),
  });

  const removeChannel = useMutation({
    mutationFn: (channelId: string) => api(`/api/channels/${channelId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['channels'] }),
    onError: (e) => setError(e.message),
  });
  const [confirmEl, confirm] = useConfirm();
  const disconnectChannel = async (ch: Channel) => {
    if (
      await confirm(
        `Disconnect ${ch.name}? Inbound messages stop arriving — the channel can be re-added later.`,
        [{ key: 'ok', label: 'Disconnect', danger: true }],
      )
    )
      removeChannel.mutate(ch.id);
  };

  const allChannels = data?.channels ?? [];
  // Grouped by channel type (alphabetical on the display label), then name.
  const channels = allChannels
    .filter((ch) => ch.agent_id === agentId)
    .sort(
      (a, b) =>
        (KIND_LABEL[a.kind] ?? a.kind).localeCompare(KIND_LABEL[b.kind] ?? b.kind) ||
        a.name.localeCompare(b.name),
    );

  const sortedPages = [...(pending.data?.pages ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const sortedWabas = (pending.data?.whatsapp ?? []).map((w) => ({
    ...w,
    phone_numbers: [...w.phone_numbers].sort((a, b) =>
      (a.display_phone_number ?? a.id).localeCompare(b.display_phone_number ?? b.id),
    ),
  }));
  const hasAssets = sortedPages.length > 0 || sortedWabas.length > 0;
  // Map a discovered asset id (page / ig account / phone_number_id) to its channel.
  const linkedChannels = new Map(
    allChannels.flatMap((ch) =>
      [ch.meta.page_id, ch.meta.phone_number_id]
        .filter((v): v is string => Boolean(v))
        .map((v) => [v, ch] as const),
    ),
  );

  /** Customer-facing chat link for a connected Meta channel. */
  const launchUrl = (ch: Channel) =>
    ch.kind === 'whatsapp' && ch.meta.phone_number
      ? `https://wa.me/${ch.meta.phone_number}`
      : ch.kind === 'instagram'
        ? `https://ig.me/m/${ch.meta.username ?? ch.meta.page_id}`
        : ch.meta.page_id
          ? `https://m.me/${ch.meta.page_id}`
          : undefined;

  /** Does the channel page carry anything beyond the row's own actions?
   *  OAuth Meta channels have no channel-specific settings (their webhook
   *  details only exist for manual Meta apps) — for those the row is just
   *  Open + Disconnect. */
  const hasConfigPage = (ch: Channel) =>
    !['messenger', 'instagram', 'whatsapp'].includes(ch.kind) || ch.meta.via !== 'oauth';

  const overrides = (ch: Channel) => {
    const bits: string[] = [];
    if (ch.meta.branding?.greeting) bits.push('custom greeting');
    const replies = ch.meta.branding?.quick_replies?.length ?? 0;
    if (replies) bits.push(`${replies} suggested repl${replies === 1 ? 'y' : 'ies'}`);
    return bits.join(' · ');
  };

  // Channel hierarchy — the draft's suggested_channels lead (the first one
  // carries the screen's one primary button); everything else collapses
  // under "More channels". Agents without a suggestion default to the two
  // most common paths: the website bubble and Meta.
  const suggestedCh = ((agent.config?.builder?.suggested_channels ?? []) as string[]).filter(
    (k): k is ChKey => (ALL_CH as string[]).includes(k),
  );
  const leadCh: ChKey[] = suggestedCh.length ? suggestedCh : ['bubble', 'meta'];
  const moreCh = ALL_CH.filter((k) => !leadCh.includes(k));
  const primaryCh = leadCh[0];
  const CH_SUMMARY: Record<ChKey, string> = {
    bubble: 'chat bubble for your website',
    meta: 'Facebook, Instagram & WhatsApp',
    gmail: 'Gmail',
    outlook: 'Outlook / Microsoft 365',
    email: 'any mailbox via forwarding',
    voice: 'voice calls',
    sms: 'SMS texting',
  };
  const firstCh = [...channels].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  )[0];

  // Members and agent-scoped users get a read-only view — wiring, credentials
  // and removal are workspace-admin actions.
  if (me && !isAdmin) {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        {channels.length === 0 && (
          <div className="muted">
            Nothing is connected — this agent isn't answering anywhere yet.
          </div>
        )}
        {channels.map((ch) => (
          <div key={ch.id} className="row" style={{ alignItems: 'baseline' }}>
            <span className="badge active">{KIND_LABEL[ch.kind] ?? ch.kind}</span>
            <strong className="grow">{ch.name}</strong>
            <span className="muted">
              {ch.meta.page_id && `page ${ch.meta.page_id}`}
              {ch.meta.phone_number_id && ch.meta.phone_number_id}
              {overrides(ch) && ` · ${overrides(ch)}`}
            </span>
            {ch.meta.chat_url && (
              <a href={ch.meta.chat_url} target="_blank" rel="noreferrer" className="btn">
                Open ↗
              </a>
            )}
          </div>
        ))}
        <div className="muted" style={{ fontSize: 13 }}>
          Channels are managed by workspace admins.
        </div>
      </div>
    );
  }

  /** One channel card per key — rendered in suggested order above the
   *  fold, everything else under "More channels". The first lead card is
   *  the screen's single primary action; a sorter pick highlights its
   *  card wherever it lives. */
  const cardFor = (k: ChKey) => {
    const primCls = primaryCh === k ? 'btn primary' : 'btn';
    const rec = need ? NEED_TO_CH[need] === k : false;
    const sTag = suggestedCh.includes(k) ? (
      <span className="ch-suggested">suggested</span>
    ) : null;
    switch (k) {
      case 'meta':
        // The asset picker is an active OAuth flow, not a card — it
        // renders standalone above the ordering.
        if (connectId && pickerOpen) return null;
        return session.data?.connected ? (
          <div className={`card connect-card${rec ? ' recommended' : ''}`} id="ch-meta">
            <div className="row">
              <div className="grow">
                <strong>Meta connected{sTag && <> — {sTag}</>}</strong>
                <div className="muted" style={{ marginTop: 4 }}>
                  {(() => {
                    const linked = channels.filter((ch) =>
                      ['messenger', 'instagram', 'whatsapp'].includes(ch.kind),
                    );
                    return linked.length
                      ? `${linked.length} channel${linked.length === 1 ? '' : 's'} linked to ${agent.name} — more Pages and numbers are available on this Meta login.`
                      : 'No channels linked to this agent yet — Pages, Instagram, and WhatsApp numbers are ready to connect.';
                  })()}
                </div>
              </div>
              <button className="btn" onClick={() => setPickerOpen(true)}>Manage</button>
              <button className="btn" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
                Disconnect
              </button>
            </div>
          </div>
        ) : session.isPending ? (
          <div className="card connect-card" id="ch-meta">
            <div className="row">
              <span className="spin" />
              <span className="muted">Checking for a stored Meta connection…</span>
            </div>
          </div>
        ) : (
          <div className={`card connect-card${rec ? ' recommended' : ''}`} id="ch-meta">
            {metaStatus.data?.configured ? (
              <>
                <div className="row">
                  <div className="grow">
                    <strong>Connect with Meta{sTag && <> — {sTag}</>}</strong>
                    {session.data?.expired && (
                      <div className="error" style={{ marginTop: 4 }}>
                        Your Facebook session expired — reconnect to manage channels.
                      </div>
                    )}
                    <div className="muted" style={{ marginTop: 4 }}>
                      Sign in once — Janis finds your Pages, Instagram accounts, and WhatsApp
                      numbers and sets up the webhook for you.
                    </div>
                    <div className="needs-line">Needs: admin access to your Facebook Page</div>
                  </div>
                  <a className={primCls} href={`/api/meta/connect?agent=${agentId}`}>Connect Facebook</a>
                </div>
                <div style={{ marginTop: 10 }}>
                  <a
                    href="#"
                    className="muted"
                    style={{ fontSize: 12 }}
                    onClick={(e) => {
                      e.preventDefault();
                      setShowManual((v) => !v);
                    }}
                  >
                    {showManual ? 'Hide credentials form' : 'Use credentials instead'}
                  </a>
                </div>
                {showManual && metaManualForm}
              </>
            ) : metaStatus.isPending ? (
              <div className="row">
                <span className="spin" />
                <span className="muted">Checking Meta configuration…</span>
              </div>
            ) : showManual ? (
              <>
                <strong>Meta with credentials{sTag && <> — {sTag}</>}</strong>
                {metaManualForm}
              </>
            ) : (
              <div className="muted">
                One-click connect isn't configured —{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setShowManual(true);
                  }}
                >
                  use credentials instead
                </a>
                , or set <span className="mono">META_APP_ID</span> and{' '}
                <span className="mono">META_APP_SECRET</span> on the API to enable it.
              </div>
            )}
          </div>
        );
      case 'bubble':
        return (
          <div className={`card connect-card${rec ? ' recommended' : ''}`} id="ch-bubble">
            <div className="row">
              <div className="grow">
                <strong>Bubble{sTag && <> — {sTag}</>}</strong>
                <div className="muted" style={{ marginTop: 4 }}>
                  Embed a chat bubble on any website — visitors land in the same inbox, with
                  agent answers and human takeover. No Meta app required.
                </div>
                <div className="needs-line">Needs: ability to add a script to your website</div>
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                className={primCls}
                disabled={createWebchat.isPending}
                onClick={() => createWebchat.mutate()}
              >
                Create bubble
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                Name, greeting and quick replies are set on the channel card.
              </span>
            </div>
          </div>
        );
      case 'gmail':
        return (
          <div className={`card connect-card${rec ? ' recommended' : ''}`} id="ch-gmail">
            <div className="row">
              <div className="grow">
                <strong>Gmail{sTag && <> — {sTag}</>}</strong>
                <div className="muted" style={{ marginTop: 4 }}>
                  Connect an existing Gmail or Google Workspace mailbox (like support@you.com) —
                  mail lands in the same inbox, and replies send from that address in the
                  customer's thread. The inbox is polled about once a minute. If the mailbox
                  belongs to someone else, send them the invite link — they grant access
                  themselves, no Janis login needed.
                </div>
                <div className="needs-line">Needs: sign-in to the mailbox — yours, or the owner's via invite</div>
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                className={primCls}
                onClick={() => {
                  window.location.href = `${apiOrigin}/api/gmail/connect?agent_id=${agentId}`;
                }}
              >
                Connect Gmail
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={gmInvite.isPending}
                onClick={() => gmInvite.mutate()}
              >
                Copy invite link
              </button>
            </div>
            {gmLink && (
              <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                Invite link (copied — valid 7 days):{' '}
                <span className="mono" style={{ wordBreak: 'break-all' }}>{gmLink}</span>
              </div>
            )}
            {gmailConnected && (
              <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                Connected <span className="mono">{gmailConnected}</span> — new mail from that inbox
                becomes conversations here; replies send from the mailbox itself.
              </div>
            )}
          </div>
        );
      case 'outlook':
        return (
          <div className={`card connect-card${rec ? ' recommended' : ''}`}>
            <div className="row">
              <div className="grow">
                <strong>Outlook / Microsoft 365{sTag && <> — {sTag}</>}</strong>
                <div className="muted" style={{ marginTop: 4 }}>
                  Connect an Outlook.com or Microsoft 365 mailbox — mail lands in the same
                  inbox and replies send from that address in the customer's thread. If the
                  mailbox belongs to someone else, send them the invite link — they grant
                  access themselves, no Janis login needed.
                </div>
                <div className="needs-line">Needs: sign-in to the mailbox — yours, or the owner's via invite</div>
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                className={primCls}
                onClick={() => {
                  window.location.href = `${apiOrigin}/api/outlook/connect?agent_id=${agentId}`;
                }}
              >
                Connect Outlook
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={olInvite.isPending}
                onClick={() => olInvite.mutate()}
              >
                Copy invite link
              </button>
            </div>
            {olLink && (
              <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                Invite link (copied — valid 7 days):{' '}
                <span className="mono" style={{ wordBreak: 'break-all' }}>{olLink}</span>
              </div>
            )}
            {outlookConnected && (
              <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                Connected <span className="mono">{outlookConnected}</span>.
              </div>
            )}
            {outlookError && (
              <div className="error" style={{ marginTop: 10 }} title={outlookError}>Outlook connect failed: {friendlyError(outlookError).text}</div>
            )}
          </div>
        );
      case 'email':
        return (
          <div className="card">
            <details className="appearance-details">
              <summary>
                <span className="details-title">Email — any provider{sTag && <> — {sTag}</>}</span>
                <span className="details-sub">
                  needs: mail forwarding or DNS access — Janis mints an inbound address you
                  forward to or point MX at
                </span>
              </summary>
              <div className="muted" style={{ marginTop: 10 }}>
                Customer mail lands in the same inbox, and replies go out as threaded email from
                that address.
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  className={primCls}
                  disabled={createEmail.isPending}
                  onClick={() => createEmail.mutate()}
                >
                  Create address
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  Name and reply From-name are set on the channel card.
                </span>
              </div>
            </details>
          </div>
        );
      case 'voice':
        return (
          <div className={`card${rec ? ' recommended' : ''}`} id="ch-voice">
            <details className="appearance-details">
              <summary>
                <span className="details-title">Voice — Twilio phone number{sTag && <> — {sTag}</>}</span>
                <span className="details-sub">
                  needs: nothing (hosted provisions a number) or your Twilio account — callers
                  talk, the agent speaks, the whole call lands in the inbox
                </span>
              </summary>
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <button
                  className={`btn ${voiceMode === 'hosted' ? 'primary' : ''}`}
                  onClick={() => setVoiceMode('hosted')}
                  disabled={!hostedConfigured}
                >
                  Get a number
                </button>
                <button
                  className={`btn ${voiceMode === 'byo' ? 'primary' : ''}`}
                  onClick={() => setVoiceMode('byo')}
                >
                  Use my Twilio account
                </button>
              </div>
              <form
                style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, maxWidth: 520 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (voiceMode === 'hosted') createVoice.mutate();
                  else createVoice.mutate();
                }}
              >
                {voiceMode === 'hosted' ? (
                  <>
                    <div className="row" style={{ gap: 8 }}>
                      <input
                        style={{ width: 130 }}
                        placeholder="Area code (e.g. 415)"
                        value={areaCode}
                        onChange={(e) => setAreaCode(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={searchNumbers.isPending}
                        onClick={() => searchNumbers.mutate()}
                      >
                        {searchNumbers.isPending ? 'Searching…' : 'Find numbers'}
                      </button>
                    </div>
                    {foundNumbers !== null &&
                      (foundNumbers.length ? (
                        <select
                          value={pickedNumber}
                          onChange={(e) => setPickedNumber(e.target.value)}
                        >
                          {foundNumbers.map((n) => (
                            <option key={n.phone_number} value={n.phone_number}>
                              {n.friendly_name}
                              {n.locality ? ` — ${n.locality}` : ''}
                              {n.region ? `, ${n.region}` : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="muted">No numbers in that area code — try another.</div>
                      ))}
                  </>
                ) : (
                  <>
                    <input
                      placeholder="Twilio Account SID (AC…)"
                      value={voiceForm.sid}
                      onChange={(e) => setVoiceForm({ ...voiceForm, sid: e.target.value })}
                      required
                    />
                    <input
                      placeholder="Twilio Auth Token"
                      value={voiceForm.token}
                      onChange={(e) => setVoiceForm({ ...voiceForm, token: e.target.value })}
                      required
                    />
                    <input
                      placeholder="Phone number — E.164, e.g. +15551234567"
                      value={voiceForm.number}
                      onChange={(e) => setVoiceForm({ ...voiceForm, number: e.target.value })}
                      required
                    />
                  </>
                )}
                <input
                  placeholder="Forward-to number when a human takes over (optional)"
                  value={voiceForm.forward_to}
                  onChange={(e) => setVoiceForm({ ...voiceForm, forward_to: e.target.value })}
                />
                <input
                  placeholder="Spoken greeting (optional)"
                  value={voiceForm.greeting}
                  onChange={(e) => setVoiceForm({ ...voiceForm, greeting: e.target.value })}
                />
                <div>
                  <button
                    className="btn"
                    disabled={
                      createVoice.isPending || (voiceMode === 'hosted' && !pickedNumber)
                    }
                  >
                    {voiceMode === 'hosted' ? 'Get this number' : 'Add voice channel'}
                  </button>
                </div>
              </form>
              <div className="muted" style={{ marginTop: 10 }}>
                {voiceMode === 'hosted'
                  ? 'Janis provisions the number and wires it up — callers are transcribed turn-by-turn, the agent answers by voice, and a human takeover can bridge straight to the forward-to number.'
                  : 'Then in the Twilio console, set the number\'s Voice → "A call comes in" webhook to the URL on the channel card. Callers are transcribed turn-by-turn; the agent\'s reply is spoken, and when a human takes over the call can bridge straight to the forward-to number.'}
              </div>
            </details>
          </div>
        );
      case 'sms':
        return (
          <div className="card">
            <details className="appearance-details">
              <summary>
                <span className="details-title">SMS — text messaging{sTag && <> — {sTag}</>}</span>
                <span className="details-sub">
                  needs: a Twilio number — texts to it become conversations here
                </span>
              </summary>
              {channels.some((v) => v.kind === 'voice') ? (
                <div style={{ marginTop: 12 }}>
                  {channels
                    .filter((v) => v.kind === 'voice')
                    .map((v) => {
                      const sibling = channels.find(
                        (s) => s.kind === 'sms' && s.meta.phone_number === v.meta.phone_number,
                      );
                      return (
                        <div key={v.id} className="row" style={{ marginBottom: 6 }}>
                          <span className="mono grow">{v.meta.phone_number ?? v.name}</span>
                          {sibling ? (
                            <span className="muted">SMS enabled</span>
                          ) : (
                            <button
                              className="btn"
                              disabled={createSms.isPending}
                              onClick={() => createSms.mutate(v.id)}
                            >
                              Enable SMS
                            </button>
                          )}
                        </div>
                      );
                    })}
                  <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                    One click — the same number answers texts and calls, and the webhook wires
                    itself.
                  </div>
                </div>
              ) : (
                <div className="muted" style={{ marginTop: 12, fontSize: 13 }}>
                  No voice number yet — get one above, or bring your own Twilio SMS number:
                </div>
              )}
              <form
                style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, maxWidth: 520 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  createSms.mutate(undefined);
                }}
              >
                <input
                  placeholder="Twilio Account SID (AC…)"
                  value={smsForm.sid}
                  onChange={(e) => setSmsForm({ ...smsForm, sid: e.target.value })}
                  required
                />
                <input
                  placeholder="Twilio Auth Token"
                  value={smsForm.token}
                  onChange={(e) => setSmsForm({ ...smsForm, token: e.target.value })}
                  required
                />
                <input
                  placeholder="SMS-capable phone number — E.164, e.g. +15551234567"
                  value={smsForm.number}
                  onChange={(e) => setSmsForm({ ...smsForm, number: e.target.value })}
                  required
                />
                <div>
                  <button className="btn" disabled={createSms.isPending}>
                    Add SMS channel
                  </button>
                </div>
              </form>
              <div className="muted" style={{ marginTop: 10 }}>
                We wire the number's inbound-message webhook automatically — texts arrive as
                conversations and replies send from the same number.
              </div>
            </details>
          </div>
        );
    }
  };

  /** The advanced Meta form — folded into the Meta card behind "Use
   *  credentials instead" instead of sitting as a card of its own. */
  const metaManualForm = (
    <>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, maxWidth: 520 }}
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <select
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}
        >
          <option value="messenger">Facebook Messenger</option>
          <option value="instagram">Instagram DM</option>
          <option value="whatsapp">WhatsApp Business</option>
        </select>
        <input
          placeholder="Channel name (e.g. Acme Facebook Page)"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
        {form.kind !== 'whatsapp' && (
          <input
            placeholder="Facebook Page ID"
            value={form.page_id}
            onChange={(e) => setForm({ ...form, page_id: e.target.value })}
            required
          />
        )}
        {form.kind === 'whatsapp' && (
          <input
            placeholder="WhatsApp phone_number_id"
            value={form.phone_number_id}
            onChange={(e) => setForm({ ...form, phone_number_id: e.target.value })}
            required
          />
        )}
        <input
          placeholder="Access token (page token / system user token)"
          value={form.access_token}
          onChange={(e) => setForm({ ...form, access_token: e.target.value })}
          required
        />
        <div>
          <button className="btn" disabled={create.isPending}>Add channel</button>
        </div>
      </form>
      <div className="muted" style={{ marginTop: 10 }}>
        Then register <span className="mono">{apiOrigin}/channels/meta/webhook</span>{' '}
        in your Meta app with the channel's verify token, and subscribe to <span className="mono">messages</span>.
      </div>
    </>
  );

  return (
    <>
      <div className="lede" style={{ marginTop: 12 }}>
        <p className="muted">
          Choose where your agent answers. It replies only while it owns the
          conversation — when a teammate takes over, it stops until you hand it back.
        </p>
      </div>

      {metaError && <div className="error" style={{ marginBottom: 12 }} title={metaError}>Meta connect failed: {friendlyError(metaError).text}</div>}
      {gmailError && <div className="error" style={{ marginBottom: 12 }} title={gmailError}>Gmail connect failed: {friendlyError(gmailError).text}</div>}
      {cfError && <div className="error" style={{ marginBottom: 12 }} title={cfError}>Cloudflare setup failed: {friendlyError(cfError).text}</div>}
      {cfConnected && (
        <div className="muted" style={{ marginBottom: 12, fontSize: 13 }}>
          ✓ {cfConnected}
        </div>
      )}
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {/* The launch moment — first channel connect flips the agent live;
          acknowledge it once, then get out of the way. */}
      {firstCh && !launchAcked && (
        <div className="card launch-banner">
          <strong className="grow">
            ✓ Your agent is live on {firstCh.name}.
            <div className="muted" style={{ fontWeight: 400, fontSize: 13, marginTop: 2 }}>
              Next: send it a message from there to confirm.
            </div>
          </strong>
          <button className="btn" onClick={ackLaunch}>Got it</button>
        </div>
      )}

      {/* Connected channels — compact index; configuration lives on each
          channel's own page (/agents/:id/channels/:channelId). */}
      {channels.length > 0 && (
        <>
          <h2 className="section-title">Connected</h2>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {channels.map((ch) => (
              <div key={ch.id} className="row" style={{ alignItems: 'baseline' }}>
                <span className="badge active">{KIND_LABEL[ch.kind] ?? ch.kind}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <strong>{ch.name}</strong>{' '}
                  {/* Subtitle only where it adds info — an email channel's
                      inbound address, an SMS/voice number. Meta channels,
                      bubbles, and Gmail/Outlook just repeat the name. */}
                  {(() => {
                    const detail =
                      ch.kind === 'email' ? ch.meta.inbound_address
                      : ch.kind === 'sms' || ch.kind === 'voice' ? ch.meta.phone_number
                      : undefined;
                    const sub = [detail, overrides(ch)].filter(Boolean).join(' · ');
                    return sub ? <span className="muted" style={{ fontSize: 12 }}>{sub}</span> : null;
                  })()}
                </div>
                {launchUrl(ch) && (
                  <a
                    href={launchUrl(ch)}
                    target="_blank"
                    rel="noreferrer"
                    className={hasConfigPage(ch) ? 'muted' : 'btn'}
                    style={hasConfigPage(ch) ? { fontSize: 12 } : undefined}
                  >
                    Open ↗
                  </a>
                )}
                {hasConfigPage(ch) && (
                  <Link className="btn" to={`/agents/${agentId}/channels/${ch.id}`}>
                    Configure
                  </Link>
                )}
                <button
                  className="btn danger"
                  disabled={removeChannel.isPending}
                  onClick={() => void disconnectChannel(ch)}
                >
                  Disconnect
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {channels.length === 0 && !connectId && (
        <p className="muted" style={{ fontSize: 13, margin: '4px 0 12px' }}>
          Not answering anywhere yet.
        </p>
      )}

      <h2 className="section-title">Add a channel</h2>

      {/* Optional sorter — pick where customers reach you and the matching
          card lights up and scrolls into view. */}
      {!connectId && (
        <div className="row" style={{ gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 12 }}>Where do your customers reach you?</span>
          {(
            [
              ['site', 'On my website'],
              ['social', 'Facebook, Instagram or WhatsApp'],
              ['email', 'Email'],
              ['phone', 'Phone or SMS'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={`try-chip${need === k ? ' pass' : ''}`}
              onClick={() => {
                const next = need === k ? null : k;
                setNeed(next);
                // A sorter pick whose card lives under "More channels"
                // opens the disclosure so the highlight is visible.
                if (next && moreCh.includes(NEED_TO_CH[next])) setMoreOpen(true);
                document
                  .getElementById(NEED_TARGETS[k])
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }}
            >
              <span className="try-chip-text">{label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Meta OAuth return lands in the asset picker — an active flow,
          so it renders above the ordering regardless of suggestion. */}
      {connectId && pickerOpen && (
        <div className="card connect-card">
          <div className="row">
            <strong className="grow">Meta connected — pick what to link to {agent.name}</strong>
            <button
              className="btn"
              onClick={() => {
                dropParams('meta_connect');
                setPickerOpen(false);
              }}
            >
              Done
            </button>
            <a href={`/api/meta/connect?agent=${agentId}`} onClick={() => dropParams('meta_connect')}>Switch account</a>
            <button className="btn" onClick={() => disconnect.mutate()}>Disconnect</button>
          </div>
          {pending.isLoading && (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="spin" />
              <span className="muted">Looking up your Meta accounts…</span>
            </div>
          )}
          {pending.isError && (
            <div className="error">
              Couldn't load your Meta assets.{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  dropParams('meta_connect');
                  void qc.invalidateQueries({ queryKey: ['meta-session'] });
                }}
              >
                Retry
              </a>
              {' · '}
              <a href={`/api/meta/connect?agent=${agentId}`}>Reconnect Facebook</a>
            </div>
          )}
          {pending.data && (
            <>
              <div className="asset-list">
                {sortedPages.map((pg) => {
                  const msgr = linkedChannels.get(pg.id);
                  const igCh = pg.instagram ? linkedChannels.get(pg.instagram.id) : undefined;
                  return (
                    <div key={pg.id} className="asset-row">
                      <div className="grow">
                        <strong>{pg.name}</strong>
                        <div className="muted">Facebook Page</div>
                        {msgr && msgr.agent_id === agentId && launchUrl(msgr) && (
                          <a href={launchUrl(msgr)} target="_blank" rel="noreferrer">
                            Launch chat on Messenger ↗
                          </a>
                        )}
                        {igCh && igCh.agent_id === agentId && launchUrl(igCh) && (
                          <a href={launchUrl(igCh)} target="_blank" rel="noreferrer" style={{ display: 'block' }}>
                            Launch chat on Instagram ↗
                          </a>
                        )}
                      </div>
                      {msgr ? (
                        msgr.agent_id === agentId ? (
                          <button className="btn danger" disabled={removeChannel.isPending}
                            onClick={() => void disconnectChannel(msgr)}>
                            Disconnect Messenger
                          </button>
                        ) : (
                          <span className="muted">Messenger on {msgr.agent_name}</span>
                        )
                      ) : pg.bound ? (
                        <>
                          <span className="muted" title={`bound to ${pg.bound.agent_name}`}>
                            on {pg.bound.workspace_name} · {pg.bound.agent_name}
                          </span>
                          <button className="btn" disabled={link.isPending}
                            onClick={async () => {
                              if (await confirm(
                                `Take Messenger over from ${pg.bound!.workspace_name}? ${pg.bound!.agent_name} loses this channel — its conversation history stays, but inbound messages come here instead.`,
                                [{ key: 'ok', label: 'Take over' }, { key: 'cancel', label: 'Cancel' }],
                              ) === 'ok') link.mutate({ kind: 'messenger', page_id: pg.id, takeover: true });
                            }}>
                            Take over
                          </button>
                        </>
                      ) : (
                        <button className="btn" disabled={link.isPending}
                          onClick={() => link.mutate({ kind: 'messenger', page_id: pg.id })}>
                          Connect Messenger
                        </button>
                      )}
                      {pg.instagram && (
                        igCh ? (
                          igCh.agent_id === agentId ? (
                            <button className="btn danger" disabled={removeChannel.isPending}
                              onClick={() => void disconnectChannel(igCh)}>
                              Disconnect Instagram
                            </button>
                          ) : (
                            <span className="muted">Instagram on {igCh.agent_name}</span>
                          )
                        ) : pg.instagram.bound ? (
                          <>
                            <span className="muted" title={`bound to ${pg.instagram.bound.agent_name}`}>
                              on {pg.instagram.bound.workspace_name} · {pg.instagram.bound.agent_name}
                            </span>
                            <button className="btn" disabled={link.isPending}
                              onClick={async () => {
                                if (await confirm(
                                  `Take Instagram over from ${pg.instagram!.bound!.workspace_name}? ${pg.instagram!.bound!.agent_name} loses this channel — its conversation history stays, but inbound messages come here instead.`,
                                  [{ key: 'ok', label: 'Take over' }, { key: 'cancel', label: 'Cancel' }],
                                ) === 'ok') link.mutate({ kind: 'instagram', page_id: pg.id, takeover: true });
                              }}>
                              Take over
                            </button>
                          </>
                        ) : (
                          <button className="btn" disabled={link.isPending}
                            onClick={() => link.mutate({ kind: 'instagram', page_id: pg.id })}>
                            Connect Instagram{pg.instagram.username ? ` @${pg.instagram.username}` : ''}
                          </button>
                        )
                      )}
                    </div>
                  );
                })}
                {sortedWabas.flatMap((w) =>
                  w.phone_numbers.map((n) => {
                    const wa = linkedChannels.get(n.id);
                    return (
                      <div key={n.id} className="asset-row">
                        <div className="grow">
                          <strong>{n.display_phone_number ?? n.id}</strong>
                          <div className="muted">WhatsApp Business{w.name ? ` · ${w.name}` : ''}</div>
                          {wa && wa.agent_id === agentId && launchUrl(wa) && (
                            <a href={launchUrl(wa)} target="_blank" rel="noreferrer">
                              Launch chat on WhatsApp ↗
                            </a>
                          )}
                        </div>
                        {wa ? (
                          wa.agent_id === agentId ? (
                            <button className="btn danger" disabled={removeChannel.isPending}
                              onClick={() => void disconnectChannel(wa)}>
                              Disconnect WhatsApp
                            </button>
                          ) : (
                            <span className="muted">WhatsApp on {wa.agent_name}</span>
                          )
                        ) : n.bound ? (
                          <>
                            <span className="muted" title={`bound to ${n.bound.agent_name}`}>
                              on {n.bound.workspace_name} · {n.bound.agent_name}
                            </span>
                            <button className="btn" disabled={link.isPending}
                              onClick={async () => {
                                if (await confirm(
                                  `Take WhatsApp over from ${n.bound!.workspace_name}? ${n.bound!.agent_name} loses this channel — its conversation history stays, but inbound messages come here instead.`,
                                  [{ key: 'ok', label: 'Take over' }, { key: 'cancel', label: 'Cancel' }],
                                ) === 'ok') link.mutate({ kind: 'whatsapp', phone_number_id: n.id, takeover: true });
                              }}>
                              Take over
                            </button>
                          </>
                        ) : (
                          <button className="btn" disabled={link.isPending}
                            onClick={() => link.mutate({ kind: 'whatsapp', phone_number_id: n.id })}>
                            Connect WhatsApp
                          </button>
                        )}
                      </div>
                    );
                  }),
                )}
              </div>
              {!hasAssets && <Empty>No Pages or WhatsApp numbers found on that Meta login.</Empty>}
            </>
          )}
        </div>
      )}

      {/* Suggested channels lead; everything else folds under "More
          channels". The first lead is the page's one primary action. */}
      {leadCh.map((k) => <Fragment key={k}>{cardFor(k)}</Fragment>)}

      {moreCh.length > 0 && (
        <details
          className="more-channels"
          open={moreOpen}
          onToggle={(e) => setMoreOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            More channels
            <span className="muted"> — {moreCh.map((k) => CH_SUMMARY[k]).join(' · ')}</span>
          </summary>
          <div className="ch-more-list">
            {moreCh.map((k) => <Fragment key={k}>{cardFor(k)}</Fragment>)}
          </div>
        </details>
      )}

      {confirmEl}
    </>
  );
}
