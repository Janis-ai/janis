import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Agent, Channel } from '@janis/shared';
import { useAgents, useChannels, useMe } from '../api/hooks';
import { Empty } from './bits';
import { ChannelCard, KIND_LABEL, type PendingAssets } from './Channels';

/**
 * Per-agent channel manager — everything the old workspace-wide /integrations
 * page did, scoped to one agent: Meta OAuth connect + asset picker, webchat,
 * email, Gmail and manual credentials, plus the channel cards themselves.
 */
export function AgentChannels({ agent }: { agent: Agent }) {
  const agentId = agent.id;
  const { data } = useChannels();
  const { data: agents } = useAgents();
  const { data: me } = useMe();
  const isAdmin = me?.user.role === 'admin';
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const metaError = params.get('meta_error') ?? '';
  const gmailError = params.get('gmail_error') ?? '';
  const gmailConnected = params.get('gmail_connect') ?? '';
  const [showManual, setShowManual] = useState(false);
  const [error, setError] = useState('');
  // Same-origin deploys serve the API on the web origin; dev splits :5173/:8787.
  const apiOrigin =
    window.location.hostname === 'localhost' ? 'http://localhost:8787' : window.location.origin;

  // Clear only our params — keep ?tab=integrations etc.
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
  const connectId =
    params.get('meta_connect') ?? (session.data?.connected ? session.data.connect_id ?? '' : '');
  const disconnect = useMutation({
    mutationFn: () => api('/api/meta/session', { method: 'DELETE' }),
    onSuccess: () => {
      dropParams('meta_connect');
      void qc.invalidateQueries({ queryKey: ['meta-session'] });
    },
  });
  const pending = useQuery({
    queryKey: ['meta-pending', connectId],
    queryFn: () => api<PendingAssets>(`/api/meta/pending?id=${connectId}`),
    // skip the Meta API call entirely while the picker is collapsed
    enabled: pickerOpen && Boolean(connectId),
    retry: false,
  });

  const link = useMutation({
    mutationFn: (body: { kind: string; page_id?: string; phone_number_id?: string }) =>
      api('/api/meta/link', {
        method: 'POST',
        body: JSON.stringify({ connect_id: connectId, agent_id: agentId, ...body }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (e) => setError(e.message),
  });

  // Deep link — ?channel=<id> scrolls to and flashes the card
  const focusChannel = params.get('channel');
  useEffect(() => {
    if (!focusChannel || !data) return;
    const el = document.getElementById(`ch-${focusChannel}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    const t = setTimeout(() => el.classList.remove('flash'), 2400);
    return () => clearTimeout(t);
  }, [focusChannel, data]);

  // Gmail OAuth lands back here with ?gmail_connect=<addr> — refresh the list.
  useEffect(() => {
    if (!gmailConnected) return;
    void qc.invalidateQueries({ queryKey: ['channels'] });
  }, [gmailConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  const [form, setForm] = useState({
    kind: 'messenger' as 'messenger' | 'instagram' | 'whatsapp',
    name: '',
    page_id: '',
    phone_number_id: '',
    access_token: '',
  });
  const create = useMutation({
    mutationFn: () =>
      api('/api/channels', {
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
    onSuccess: () => {
      setForm({ ...form, name: '', page_id: '', phone_number_id: '', access_token: '' });
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (e) => setError(e.message),
  });

  // Web chat widget — no credentials needed; name/greeting/replies are
  // edited on the channel card after creation.
  const createWebchat = useMutation({
    mutationFn: () =>
      api('/api/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'webchat',
          name: `${agent.name} web chat`,
          agent_id: agentId,
        }),
      }),
    onSuccess: () => {
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (e) => setError(e.message),
  });

  // Email channel — the address is minted server-side; shown once created.
  const [emCreated, setEmCreated] = useState('');
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
      setEmCreated(r.channel.meta.inbound_address ?? '');
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
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
      api('/api/channels', {
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
    onSuccess: () => {
      setVoiceForm({ sid: '', token: '', number: '', forward_to: '', greeting: '' });
      setFoundNumbers(null);
      setPickedNumber('');
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (e) => setError(e.message),
  });

  // SMS — clone a voice channel's number/creds (from_voice_channel_id), or
  // BYO Twilio account sid + token + SMS-capable number.
  const [smsForm, setSmsForm] = useState({ sid: '', token: '', number: '' });
  const createSms = useMutation({
    mutationFn: (fromVoiceId?: string) =>
      api('/api/channels', {
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
    onSuccess: () => {
      setSmsForm({ sid: '', token: '', number: '' });
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (e) => setError(e.message),
  });

  const removeChannel = useMutation({
    mutationFn: (channelId: string) => api(`/api/channels/${channelId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['channels'] }),
  });

  const allChannels = data?.channels ?? [];
  const channels = allChannels.filter((ch) => ch.agent_id === agentId);
  const allAgents = agents?.agents ?? [];

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
  // Meta channels managed inline in the picker; anything the picker can't see
  // (no session, or the asset vanished from the Meta account) still needs a row.
  const META_KINDS = new Set(['messenger', 'instagram', 'whatsapp']);
  const pendingAssetIds = new Set([
    ...sortedPages.flatMap((pg) => [pg.id, ...(pg.instagram ? [pg.instagram.id] : [])]),
    ...sortedWabas.flatMap((w) => w.phone_numbers.map((n) => n.id)),
  ]);
  const uncoveredMeta = channels.filter(
    (ch) =>
      META_KINDS.has(ch.kind) &&
      !pendingAssetIds.has(ch.meta.page_id ?? '') &&
      !pendingAssetIds.has(ch.meta.phone_number_id ?? ''),
  );
  const cardChannels = channels.filter((ch) => !META_KINDS.has(ch.kind));

  /** Customer-facing chat link for a connected Meta channel. */
  const launchUrl = (ch: Channel) =>
    ch.kind === 'whatsapp' && ch.meta.phone_number
      ? `https://wa.me/${ch.meta.phone_number}`
      : ch.kind === 'instagram'
        ? `https://ig.me/m/${ch.meta.username ?? ch.meta.page_id}`
        : ch.meta.page_id
          ? `https://m.me/${ch.meta.page_id}`
          : undefined;

  const overrides = (ch: Channel) => {
    const bits: string[] = [];
    if (ch.meta.branding?.greeting) bits.push('custom greeting');
    const replies = ch.meta.branding?.quick_replies?.length ?? 0;
    if (replies) bits.push(`${replies} suggested repl${replies === 1 ? 'y' : 'ies'}`);
    return bits.join(' · ');
  };

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

  return (
    <>
      <div className="lede" style={{ marginTop: 12 }}>
        <p className="muted">
          Where this agent answers — Messenger, Instagram, WhatsApp, web chat, and email.
          Messages relay to the agent only while it owns the conversation; during a human
          takeover it's cut off at the pipe.
        </p>
      </div>

      {metaError && <div className="error" style={{ marginBottom: 12 }}>Meta connect failed: {metaError}</div>}
      {gmailError && <div className="error" style={{ marginBottom: 12 }}>Gmail connect failed: {gmailError}</div>}
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Meta connect (primary path) or the pending asset picker */}
      {connectId && pickerOpen ? (
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
                            onClick={() => removeChannel.mutate(msgr.id)}>
                            Disconnect Messenger
                          </button>
                        ) : (
                          <span className="muted">Messenger on {msgr.agent_name}</span>
                        )
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
                              onClick={() => removeChannel.mutate(igCh.id)}>
                              Disconnect Instagram
                            </button>
                          ) : (
                            <span className="muted">Instagram on {igCh.agent_name}</span>
                          )
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
                              onClick={() => removeChannel.mutate(wa.id)}>
                              Disconnect WhatsApp
                            </button>
                          ) : (
                            <span className="muted">WhatsApp on {wa.agent_name}</span>
                          )
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
      ) : session.data?.connected ? (
        <div className="card connect-card">
          <div className="row">
            <div className="grow">
              <strong>Meta connected</strong>
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
        <div className="card connect-card">
          <div className="row">
            <span className="spin" />
            <span className="muted">Checking for a stored Meta connection…</span>
          </div>
        </div>
      ) : (
        <div className="card connect-card">
          {metaStatus.data?.configured ? (
            <div className="row">
              <div className="grow">
                <strong>Connect with Meta</strong>
                {session.data?.expired && (
                  <div className="error" style={{ marginTop: 4 }}>
                    Your Facebook session expired — reconnect to manage channels.
                  </div>
                )}
                <div className="muted" style={{ marginTop: 4 }}>
                  Sign in once — Janis finds your Pages, Instagram accounts, and WhatsApp numbers
                  and sets up the webhook for you.
                </div>
              </div>
              <a className="btn primary" href={`/api/meta/connect?agent=${agentId}`}>Connect Facebook</a>
            </div>
          ) : (
            <div className="muted">
              One-click connect isn't configured — set <span className="mono">META_APP_ID</span> and{' '}
              <span className="mono">META_APP_SECRET</span> on the API to enable it.
            </div>
          )}
        </div>
      )}

      {/* Manual Meta entry — advanced fallback for the connect flow */}
      <div className="card">
        <details open={showManual} onToggle={(e) => setShowManual((e.target as HTMLDetailsElement).open)}>
          <summary><strong>Connect to Meta with credentials</strong></summary>
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
        </details>
      </div>

      {/* Web chat widget */}
      <div className="card connect-card">
        <div className="row">
          <div className="grow">
            <strong>Web chat widget</strong>
            <div className="muted" style={{ marginTop: 4 }}>
              Embed a chat bubble on any website — visitors land in the same inbox, with
              agent answers and human takeover. No Meta app required.
            </div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn"
            disabled={createWebchat.isPending}
            onClick={() => createWebchat.mutate()}
          >
            Create widget
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            Name, greeting and quick replies are set on the channel card.
          </span>
        </div>
      </div>

      {/* Gmail — the obvious email path: OAuth onto an existing mailbox */}
      <div className="card connect-card">
        <div className="row">
          <div className="grow">
            <strong>Gmail</strong>
            <div className="muted" style={{ marginTop: 4 }}>
              Connect an existing Gmail or Google Workspace mailbox (like support@you.com) —
              mail lands in the same inbox, and replies send from that address in the
              customer's thread. The inbox is polled about once a minute. If the mailbox
              belongs to someone else, send them the invite link — they grant access
              themselves, no Janis login needed.
            </div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn primary"
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
            title="Link for whoever controls the mailbox — works without a Janis login (expires in 7 days)"
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

      {/* Email — advanced: a minted inbound address for any provider
          (forwarding or MX), for mailboxes that aren't Gmail. */}
      <div className="card">
        <details className="appearance-details">
          <summary>
            <span className="details-title">Email — any provider</span>
            <span className="details-sub">
              advanced: Janis mints an inbound address; forward an existing mailbox to it or
              point a domain's MX at it
            </span>
          </summary>
          <div className="muted" style={{ marginTop: 10 }}>
            Customer mail lands in the same inbox, and replies go out as threaded email from
            that address.
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn"
              disabled={createEmail.isPending}
              onClick={() => createEmail.mutate()}
            >
              Create address
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              Name and reply From-name are set on the channel card.
            </span>
          </div>
          {emCreated && (
            <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
              Address created: <span className="mono">{emCreated}</span> — point this domain's MX
              at your inbound provider, or forward an existing mailbox to it.
            </div>
          )}
        </details>
      </div>

      {/* Voice — Twilio number answers calls: caller speech is transcribed,
          the agent replies with TTS, and the transcript lands in the inbox. */}
      <div className="card">
        <details className="appearance-details">
          <summary>
            <span className="details-title">Voice — Twilio phone number</span>
            <span className="details-sub">
              callers talk, the agent speaks — the whole call lands in the inbox
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

      {/* SMS — one click off an existing voice number, or BYO Twilio creds.
          Texts land in the same inbox; replies go out via the Messages API. */}
      <div className="card">
        <details className="appearance-details">
          <summary>
            <span className="details-title">SMS — text messaging</span>
            <span className="details-sub">
              texts to your Twilio number become conversations here
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

      {/* This agent's connected channels — Meta channels are managed in the
          picker above; cards here carry the non-Meta config (embed, branding,
          inbound addresses). Meta channels the picker can't see (no session,
          asset gone) fall back to a compact row so they're never stranded. */}
      {(cardChannels.length > 0 || uncoveredMeta.length > 0) && (
        <h2 className="section-title">Connected channels</h2>
      )}
      {cardChannels.map((ch) => (
        <ChannelCard key={ch.id} ch={ch} agents={allAgents} />
      ))}
      {uncoveredMeta.length > 0 && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {uncoveredMeta.map((ch) => (
            <div key={ch.id} className="row" style={{ alignItems: 'baseline' }}>
              <div className="grow">
                <strong>{ch.name}</strong>
                <div className="muted">{KIND_LABEL[ch.kind] ?? ch.kind}</div>
                {launchUrl(ch) && (
                  <a href={launchUrl(ch)} target="_blank" rel="noreferrer">
                    Launch chat on {KIND_LABEL[ch.kind] ?? ch.kind} ↗
                  </a>
                )}
              </div>
              <button
                className="btn danger"
                style={{ whiteSpace: 'nowrap' }}
                disabled={removeChannel.isPending}
                onClick={() => removeChannel.mutate(ch.id)}
              >
                Disconnect {KIND_LABEL[ch.kind] ?? ch.kind}
              </button>
            </div>
          ))}
        </div>
      )}
      {channels.length === 0 && !connectId && (
        <Empty>No channels connected yet — this agent isn't answering anywhere.</Empty>
      )}
    </>
  );
}
