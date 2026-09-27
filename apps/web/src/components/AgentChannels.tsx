import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Agent, Channel } from '@janis/shared';
import { useAgents, useChannels, useMe } from '../api/hooks';
import { Empty } from './bits';
import { ChannelCard, KIND_LABEL, parseReplies, type PendingAssets } from './Channels';

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
    enabled: Boolean(connectId),
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

  // Web chat widget — no credentials needed, just a display config.
  const [wcForm, setWcForm] = useState({ name: '', greeting: '', quick_replies: '' });
  const createWebchat = useMutation({
    mutationFn: () =>
      api('/api/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'webchat',
          name: wcForm.name,
          agent_id: agentId,
          greeting: wcForm.greeting || undefined,
          quick_replies: parseReplies(wcForm.quick_replies),
        }),
      }),
    onSuccess: () => {
      setWcForm({ name: '', greeting: '', quick_replies: '' });
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (e) => setError(e.message),
  });

  // Email channel — the address is minted server-side; shown once created.
  const [emForm, setEmForm] = useState({ name: '', from_name: '' });
  const [emCreated, setEmCreated] = useState('');
  const createEmail = useMutation({
    mutationFn: () =>
      api<{ channel: Channel }>('/api/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'email',
          name: emForm.name,
          agent_id: agentId,
          from_name: emForm.from_name || undefined,
        }),
      }),
    onSuccess: (r) => {
      setEmCreated(r.channel.meta.inbound_address ?? '');
      setEmForm({ name: '', from_name: '' });
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (e) => setError(e.message),
  });

  // Gmail — OAuth round-trip creates the channel; optional display name.
  const [gmName, setGmName] = useState('');
  const [gmLink, setGmLink] = useState('');
  const gmInvite = useMutation({
    mutationFn: () =>
      api<{ url: string }>(
        `/api/gmail/connect-link?agent_id=${agentId}${gmName ? `&name=${encodeURIComponent(gmName)}` : ''}`,
      ),
    onSuccess: async (r) => {
      setGmLink(r.url);
      try {
        await navigator.clipboard.writeText(r.url);
      } catch {}
    },
  });

  const allChannels = data?.channels ?? [];
  const channels = allChannels.filter((ch) => ch.agent_id === agentId);
  const allAgents = agents?.agents ?? [];

  const hasAssets =
    pending.data && (pending.data.pages.length > 0 || pending.data.whatsapp.length > 0);
  // Map a discovered asset id (page / ig account / phone_number_id) to its channel.
  const linkedChannels = new Map(
    allChannels.flatMap((ch) =>
      [ch.meta.page_id, ch.meta.phone_number_id]
        .filter((v): v is string => Boolean(v))
        .map((v) => [v, ch] as const),
    ),
  );

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
      {connectId ? (
        <div className="card connect-card">
          <div className="row">
            <strong className="grow">Meta connected — pick what to link to {agent.name}</strong>
            <a href={`/api/meta/connect?agent=${agentId}`} onClick={() => dropParams('meta_connect')}>Switch account</a>
            <button className="btn" onClick={() => disconnect.mutate()}>Disconnect</button>
          </div>
          {pending.isLoading && <div className="muted" style={{ marginTop: 8 }}>Looking up your Meta accounts…</div>}
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
                {pending.data.pages.map((pg) => (
                  <div key={pg.id} className="asset-row">
                    <div className="grow">
                      <strong>{pg.name}</strong>
                      <div className="muted">Facebook Page</div>
                    </div>
                    {linkedChannels.has(pg.id) ? (
                      <span className="muted">
                        Messenger on {linkedChannels.get(pg.id)!.agent_name}
                      </span>
                    ) : (
                      <button className="btn" disabled={link.isPending}
                        onClick={() => link.mutate({ kind: 'messenger', page_id: pg.id })}>
                        Connect Messenger
                      </button>
                    )}
                    {pg.instagram && (
                      linkedChannels.has(pg.instagram.id) ? (
                        <span className="muted">
                          Instagram on {linkedChannels.get(pg.instagram.id)!.agent_name}
                        </span>
                      ) : (
                        <button className="btn" disabled={link.isPending}
                          onClick={() => link.mutate({ kind: 'instagram', page_id: pg.id })}>
                          Connect Instagram{pg.instagram.username ? ` @${pg.instagram.username}` : ''}
                        </button>
                      )
                    )}
                  </div>
                ))}
                {pending.data.whatsapp.flatMap((w) =>
                  w.phone_numbers.map((n) => (
                    <div key={n.id} className="asset-row">
                      <div className="grow">
                        <strong>{n.display_phone_number ?? n.id}</strong>
                        <div className="muted">WhatsApp Business{w.name ? ` · ${w.name}` : ''}</div>
                      </div>
                      {linkedChannels.has(n.id) ? (
                        <span className="muted">
                          WhatsApp on {linkedChannels.get(n.id)!.agent_name}
                        </span>
                      ) : (
                        <button className="btn" disabled={link.isPending}
                          onClick={() => link.mutate({ kind: 'whatsapp', phone_number_id: n.id })}>
                          Connect WhatsApp
                        </button>
                      )}
                    </div>
                  )),
                )}
              </div>
              {!hasAssets && <Empty>No Pages or WhatsApp numbers found on that Meta login.</Empty>}
            </>
          )}
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
        <form
          className="row wrap"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            createWebchat.mutate();
          }}
        >
          <input
            className="grow"
            placeholder="Widget name (e.g. Acme website)"
            value={wcForm.name}
            onChange={(e) => setWcForm({ ...wcForm, name: e.target.value })}
            required
          />
          <input
            className="grow"
            placeholder="Greeting — overrides the agent's greeting (optional)"
            value={wcForm.greeting}
            onChange={(e) => setWcForm({ ...wcForm, greeting: e.target.value })}
          />
          <input
            className="grow"
            placeholder="Quick replies — comma-separated (optional, e.g. Pricing, Support, Book demo)"
            value={wcForm.quick_replies}
            onChange={(e) => setWcForm({ ...wcForm, quick_replies: e.target.value })}
          />
          <button className="btn" disabled={createWebchat.isPending}>Create widget</button>
        </form>
      </div>

      {/* Email channel */}
      <div className="card connect-card">
        <div className="row">
          <div className="grow">
            <strong>Email</strong>
            <div className="muted" style={{ marginTop: 4 }}>
              Give the agent its own inbound address — customer mail lands in the same inbox,
              and replies go out as threaded email from that address.
            </div>
          </div>
        </div>
        <form
          className="row wrap"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            createEmail.mutate();
          }}
        >
          <input
            className="grow"
            placeholder="Channel name (e.g. Acme support inbox)"
            value={emForm.name}
            onChange={(e) => setEmForm({ ...emForm, name: e.target.value })}
            required
          />
          <input
            className="grow"
            placeholder="From name on replies (optional, e.g. Acme Support)"
            value={emForm.from_name}
            onChange={(e) => setEmForm({ ...emForm, from_name: e.target.value })}
          />
          <button className="btn" disabled={createEmail.isPending}>Create address</button>
        </form>
        {emCreated && (
          <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
            Address created: <span className="mono">{emCreated}</span> — point this domain's MX
            at your inbound provider, or forward an existing mailbox to it.
          </div>
        )}
      </div>

      {/* Gmail channel */}
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
        <form
          className="row wrap"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            const q = new URLSearchParams({ agent_id: agentId });
            if (gmName) q.set('name', gmName);
            window.location.href = `${apiOrigin}/api/gmail/connect?${q}`;
          }}
        >
          <input
            className="grow"
            placeholder="Channel name (optional — defaults to the mailbox address)"
            value={gmName}
            onChange={(e) => setGmName(e.target.value)}
          />
          <button className="btn">Connect Gmail</button>
          <button
            type="button"
            className="btn ghost"
            disabled={gmInvite.isPending}
            title="Link for whoever controls the mailbox — works without a Janis login (expires in 7 days)"
            onClick={() => gmInvite.mutate()}
          >
            Copy invite link
          </button>
        </form>
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

      {/* This agent's connected channels */}
      {channels.length > 0 && <h2 className="section-title">Connected channels</h2>}
      {channels.map((ch) => (
        <ChannelCard key={ch.id} ch={ch} agents={allAgents} />
      ))}
      {channels.length === 0 && !connectId && (
        <Empty>No channels connected yet — this agent isn't answering anywhere.</Empty>
      )}

      {/* Manual entry — advanced */}
      <div className="card">
        <details open={showManual} onToggle={(e) => setShowManual((e.target as HTMLDetailsElement).open)}>
          <summary><strong>Advanced: connect with credentials</strong></summary>
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
    </>
  );
}
