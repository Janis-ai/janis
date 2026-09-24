import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Agent, Channel } from '@janis/shared';
import { useAgents, useChannels, useMe } from '../api/hooks';
import { CodeBlock, Empty } from '../components/bits';

interface PendingAssets {
  pages: { id: string; name: string; instagram: { id: string; username?: string } | null }[];
  whatsapp: { id: string; name?: string; phone_numbers: { id: string; display_phone_number?: string }[] }[];
}

const KIND_LABEL: Record<string, string> = {
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  webchat: 'Web chat',
};

/** Comma- or newline-separated text → trimmed array of quick-reply labels. */
function parseReplies(text: string): string[] {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Hosted channel integrations — Messenger / Instagram / WhatsApp.
 * Janis owns the Meta webhook; inbound messages reach the agent only while
 * it owns the conversation (enforced gating during human takeover).
 */
export default function Integrations() {
  const { data } = useChannels();
  const { data: agents } = useAgents();
  const { data: me } = useMe();
  const isAdmin = me?.user.role === 'admin';
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const metaError = params.get('meta_error') ?? '';
  const [showManual, setShowManual] = useState(false);
  const [linkAgent, setLinkAgent] = useState(() => params.get('agent') ?? '');
  const [error, setError] = useState('');
  // Same-origin deploys serve the API on the web origin; dev splits :5173/:8787.
  const apiOrigin =
    window.location.hostname === 'localhost' ? 'http://localhost:8787' : window.location.origin;

  const metaStatus = useQuery({
    queryKey: ['meta-status'],
    queryFn: () => api<{ configured: boolean }>('/api/meta/status'),
    staleTime: Infinity,
  });
  const session = useQuery({
    queryKey: ['meta-session'],
    queryFn: () =>
      api<{ connected: boolean; connect_id?: string; expired?: boolean }>('/api/meta/session'),
    staleTime: 60_000,
  });
  const connectId =
    params.get('meta_connect') ?? (session.data?.connected ? session.data.connect_id ?? '' : '');
  const disconnect = useMutation({
    mutationFn: () => api('/api/meta/session', { method: 'DELETE' }),
    onSuccess: () => {
      setParams({});
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
        body: JSON.stringify({ connect_id: connectId, agent_id: linkAgent, ...body }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (e) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['channels'] }),
    onError: (e) => setError(e.message),
  });

  // Deep link — /integrations?channel=<id> scrolls to and flashes the card
  // (Edit on the agent's Integrations tab lands here)
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

  const [form, setForm] = useState({
    kind: 'messenger' as 'messenger' | 'instagram' | 'whatsapp',
    name: '',
    agent_id: params.get('agent') ?? '',
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
          agent_id: form.agent_id,
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

  // Web chat widget — no credentials needed, just an agent + display config.
  const [wcForm, setWcForm] = useState({
    name: '',
    agent_id: params.get('agent') ?? '',
    greeting: '',
    quick_replies: '',
  });
  const createWebchat = useMutation({
    mutationFn: () =>
      api('/api/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'webchat',
          name: wcForm.name,
          agent_id: wcForm.agent_id,
          greeting: wcForm.greeting || undefined,
          quick_replies: parseReplies(wcForm.quick_replies),
        }),
      }),
    onSuccess: () => {
      setWcForm({ ...wcForm, name: '', greeting: '', quick_replies: '' });
      setError('');
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
    onError: (e) => setError(e.message),
  });

  const hasAssets =
    pending.data && (pending.data.pages.length > 0 || pending.data.whatsapp.length > 0);
  // Map a discovered asset id (page / ig account / phone_number_id) to its channel.
  const linkedChannels = new Map(
    (data?.channels ?? []).flatMap((ch) =>
      [ch.meta.page_id, ch.meta.phone_number_id]
        .filter((v): v is string => Boolean(v))
        .map((v) => [v, ch.id] as const),
    ),
  );

  // Members get a read-only view — wiring, credentials, and removal are admin actions.
  if (me && !isAdmin) {
    return (
      <>
        <h1 className="page-title">Integrations</h1>
        <div className="card">
          {data?.channels.length ? (
            data.channels.map((ch) => (
              <div key={ch.id} className="row" style={{ marginTop: 8 }}>
                <span className="badge active">{KIND_LABEL[ch.kind] ?? ch.kind}</span>
                <strong className="grow">{ch.name}</strong>
                <span className="muted">{ch.agent_name}</span>
                {ch.meta.chat_url && (
                  <a href={ch.meta.chat_url} target="_blank" rel="noreferrer" className="btn">
                    Open ↗
                  </a>
                )}
              </div>
            ))
          ) : (
            <div className="muted">No integrations connected.</div>
          )}
          <div className="muted" style={{ marginTop: 12 }}>
            Integrations are managed by workspace admins.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="page-title">Integrations</h1>
      <div className="lede">
        <p>Where your agent answers:</p>
        <ul>
          <li>
            <strong>Messenger, Instagram, WhatsApp</strong> — connect your Meta business;
            Janis hosts the webhook.
          </li>
          <li>
            <strong>Web chat</strong> — an embeddable widget for your own site.
          </li>
        </ul>
        <p className="muted">
          Messages relay to your agent only while it owns the conversation — during a human
          takeover it's cut off at the pipe.
        </p>
      </div>

      {metaError && <div className="error" style={{ marginBottom: 12 }}>Meta connect failed: {metaError}</div>}
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Step 1: OAuth connect (primary path) or pending asset picker */}
      {connectId ? (
        <div className="card connect-card">
          <div className="row">
            <strong className="grow">Meta connected — pick what to link</strong>
            <a href="/api/meta/connect" onClick={() => setParams({})}>Switch account</a>
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
                  setParams({});
                  void qc.invalidateQueries({ queryKey: ['meta-session'] });
                }}
              >
                Retry
              </a>
              {' · '}
              <a href="/api/meta/connect">Reconnect Facebook</a>
            </div>
          )}
          {pending.data && (
            <>
              <div className="row" style={{ marginTop: 12 }}>
                <label style={{ margin: 0 }}>Answered by</label>
                <select value={linkAgent} onChange={(e) => setLinkAgent(e.target.value)} className="grow">
                  <option value="">choose an agent…</option>
                  {agents?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="asset-list">
                {pending.data.pages.map((pg) => (
                  <div key={pg.id} className="asset-row">
                    <div className="grow">
                      <strong>{pg.name}</strong>
                      <div className="muted">Facebook Page</div>
                    </div>
                    {linkedChannels.has(pg.id) ? (
                      <button className="btn danger" disabled={remove.isPending}
                        onClick={() => remove.mutate(linkedChannels.get(pg.id)!)}>
                        Remove Messenger
                      </button>
                    ) : (
                      <button className="btn" disabled={!linkAgent || link.isPending}
                        onClick={() => link.mutate({ kind: 'messenger', page_id: pg.id })}>
                        Connect Messenger
                      </button>
                    )}
                    {pg.instagram && (
                      linkedChannels.has(pg.instagram.id) ? (
                        <button className="btn danger" disabled={remove.isPending}
                          onClick={() => remove.mutate(linkedChannels.get(pg.instagram!.id)!)}>
                          Remove Instagram
                        </button>
                      ) : (
                        <button className="btn" disabled={!linkAgent || link.isPending}
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
                        <button className="btn danger" disabled={remove.isPending}
                          onClick={() => remove.mutate(linkedChannels.get(n.id)!)}>
                          Remove WhatsApp
                        </button>
                      ) : (
                        <button className="btn" disabled={!linkAgent || link.isPending}
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
              <a className="btn primary" href="/api/meta/connect">Connect Facebook</a>
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
          <select
            value={wcForm.agent_id}
            onChange={(e) => setWcForm({ ...wcForm, agent_id: e.target.value })}
            required
          >
            <option value="">Which agent answers?…</option>
            {agents?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
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

      {/* Connected channels */}
      {data && data.channels.length > 0 && (
        <h2 className="section-title">Connected channels</h2>
      )}
      {data?.channels.map((ch) => (
        <ChannelCard key={ch.id} ch={ch} agents={agents?.agents ?? []} />
      ))}
      {data && data.channels.length === 0 && !connectId && (
        <Empty>No channels connected yet.</Empty>
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
            <div className="row">
              <select
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}
              >
                <option value="messenger">Facebook Messenger</option>
                <option value="instagram">Instagram DM</option>
                <option value="whatsapp">WhatsApp Business</option>
              </select>
              <select
                className="grow"
                value={form.agent_id}
                onChange={(e) => setForm({ ...form, agent_id: e.target.value })}
                required
              >
                <option value="">Which agent answers?…</option>
                {agents?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
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

/** A single connected channel — rendered in the list below and standalone on
 *  /integrations/:id, which skips the Meta session queries entirely. */
export function ChannelCard({
  ch,
  agents,
  deletedTo = '/integrations',
  standalone = false,
}: {
  ch: Channel;
  agents: Agent[];
  /** Where to land after Remove — the standalone editor passes its back target. */
  deletedTo?: string;
  /** Standalone /integrations/:id hides the Edit permalink — you're already there. */
  standalone?: boolean;
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const apiOrigin =
    window.location.hostname === 'localhost' ? 'http://localhost:8787' : window.location.origin;
  const chAgent = agents.find((a) => a.id === ch.agent_id);
  const dead = chAgent && !chAgent.hosted && !chAgent.webhook_url;
  const reassign = useMutation({
    mutationFn: (agent_id: string) =>
      api(`/api/channels/${ch.id}`, { method: 'PATCH', body: JSON.stringify({ agent_id }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      void qc.invalidateQueries({ queryKey: ['channel', ch.id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/channels/${ch.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      nav(deletedTo);
    },
  });
  return (
    <div id={`ch-${ch.id}`} className="card channel-card">
      <div className="row">
        <strong className="grow">{ch.name}</strong>
        <span className="badge active">{KIND_LABEL[ch.kind] ?? ch.kind}</span>
        {!standalone && (
          <Link to={`/integrations/${ch.id}`} className="btn">Edit</Link>
        )}
        <button className="btn danger" onClick={() => remove.mutate()}>Remove</button>
      </div>
      <div className="muted" style={{ marginTop: 6 }}>
        Answered by{' '}
        <select
          value={ch.agent_id}
          onChange={(e) => reassign.mutate(e.target.value)}
          disabled={reassign.isPending}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        {dead && <span className="badge warn" style={{ marginLeft: 6 }}>agent unreachable</span>}
        {ch.meta.page_id && <> · page {ch.meta.page_id}</>}
        {ch.meta.phone_number_id && <> · {ch.meta.phone_number_id}</>}
      </div>
      {dead && (
        <div style={{ color: '#fde047', marginTop: 6, fontSize: 13 }}>
          {ch.agent_name} has no webhook URL and isn't hosted by Janis — inbound messages on this
          channel go unanswered. Fix it on the agent's page.
        </div>
      )}
      {ch.meta.chat_url && (
        <div style={{ marginTop: 6 }}>
          <a href={ch.meta.chat_url} target="_blank" rel="noreferrer">
            Open chat as a customer ↗
          </a>
        </div>
      )}
      {ch.kind === 'webchat' && (
        <>
          <CodeBlock
            title="Embed — paste before </body> on your site"
            code={`<script src="${apiOrigin}/widget.js" data-janis-token="${ch.id}" async></script>`}
          />
          <WebchatIdentity channel={ch} />
          <details className="webhook-details" style={{ marginTop: 8 }}>
            <summary>Appearance — branding for the embedded widget</summary>
            <WebchatBranding channel={ch} />
          </details>
        </>
      )}
      {ch.meta.via !== 'oauth' && ch.kind !== 'webchat' && (
      <details className="webhook-details">
        <summary>Webhook details</summary>
        <div className="mono" style={{ marginTop: 6 }}>
          <div>URL: {apiOrigin}/channels/meta/webhook</div>
          <div>Verify token: {ch.meta.verify_token}</div>
        </div>
      </details>
      )}
    </div>
  );
}

/** Webchat widget appearance editor — PATCHes display config on the channel. */
/** Visitor identity for the webchat widget: unsigned claims vs HMAC-signed
 *  identity, and the channel's signing secret. */
function WebchatIdentity({ channel }: { channel: Channel }) {
  const qc = useQueryClient();
  const [secret, setSecret] = useState(channel.meta.identity_secret ?? '');
  const [msg, setMsg] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ identity_secret: secret.trim() }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      setMsg(secret.trim() ? 'Saved — signed identity is now enabled.' : 'Cleared — signed identity disabled.');
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'Save failed'),
  });
  const generate = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    setSecret([...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''));
    setMsg('Generated — Save to activate.');
  };
  return (
    <div style={{ marginTop: 14 }}>
      <strong style={{ fontSize: 13 }}>Identify logged-in visitors</strong>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
        Anonymous by default. If your site has accounts, tell the widget who the visitor is — the
        agent sees their name/email/account id instead of asking. To mark the identity{' '}
        <em>verified</em> (required before the agent trusts the account id for lookups), sign it on
        your server with the secret below — never in browser JavaScript.
      </div>
      <CodeBlock
        title="Your server — sign the identity (Node.js)"
        code={`const sig = crypto.createHmac('sha256', IDENTITY_SECRET)
  .update(\`\${user.id}|\${user.email}|\${user.name}\`)
  .digest('hex');
// send sig to the page with the rest of the user payload`}
      />
      <CodeBlock
        title="Your page — after the widget script"
        code={`Janis.identify({ id: user.id, name: user.name, email: user.email, sig });
// or unsigned (self-reported name/email only):
Janis.identify({ id: user.id, name: user.name, email: user.email });`}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <input
          className="grow mono"
          placeholder="Identity signing secret (optional)"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <button className="btn" type="button" onClick={generate}>Generate</button>
        <button className="btn" disabled={save.isPending} onClick={() => save.mutate()}>Save</button>
      </div>
      {msg && <div className="muted" style={{ fontSize: 12 }}>{msg}</div>}
      {channel.meta.identity_secret && secret !== channel.meta.identity_secret && (
        <div className="muted" style={{ fontSize: 12 }}>unsaved changes — the widget still uses the stored secret</div>
      )}
    </div>
  );
}

function WebchatBranding({ channel }: { channel: Channel }) {
  const qc = useQueryClient();
  const b = channel.meta.branding ?? {};
  const [f, setF] = useState({
    title: b.title ?? '',
    subtitle: b.subtitle ?? '',
    greeting: b.greeting ?? '',
    accent: b.accent ?? '#5b21b6',
    position: b.position ?? 'right',
    logo_url: b.logo_url ?? '',
    quick_replies: (b.quick_replies ?? []).join(', '),
  });
  const [msg, setMsg] = useState('');
  const uploadLogo = async (file: File) => {
    setMsg('Uploading…');
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'include' });
    if (res.ok) {
      const att = (await res.json()) as { url: string };
      setF((cur) => ({ ...cur, logo_url: att.url }));
      setMsg('Logo uploaded — save appearance to apply.');
    } else {
      setMsg('Upload failed.');
    }
  };
  const save = useMutation({
    mutationFn: () =>
      api(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          branding: {
            title: f.title,
            subtitle: f.subtitle,
            greeting: f.greeting,
            accent: f.accent,
            position: f.position,
            logo_url: f.logo_url,
            quick_replies: parseReplies(f.quick_replies),
          },
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      setMsg('Saved — the widget picks it up on the next page load.');
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : 'Save failed'),
  });
  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, maxWidth: 460 }}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Accent{' '}
          <input
            type="color"
            value={f.accent}
            onChange={(e) => setF({ ...f, accent: e.target.value })}
          />
        </label>
        <label className="grow" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Position
          <select value={f.position} onChange={(e) => setF({ ...f, position: e.target.value as 'left' | 'right' })}>
            <option value="right">Bottom right</option>
            <option value="left">Bottom left</option>
          </select>
        </label>
      </div>
      <input
        placeholder="Header title (defaults to widget name)"
        value={f.title}
        onChange={(e) => setF({ ...f, title: e.target.value })}
      />
      <input
        placeholder="Subtitle (defaults to agent name)"
        value={f.subtitle}
        onChange={(e) => setF({ ...f, subtitle: e.target.value })}
      />
      <input
        placeholder="Greeting — overrides the agent's greeting (optional)"
        value={f.greeting}
        onChange={(e) => setF({ ...f, greeting: e.target.value })}
      />
      <div className="row">
        <input
          className="grow"
          placeholder="Logo image URL — header + bubble icon (optional)"
          value={f.logo_url}
          onChange={(e) => setF({ ...f, logo_url: e.target.value })}
        />
        <label className="btn" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
          Upload image
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadLogo(file);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {f.logo_url && (
        <div className="row">
          <img
            src={f.logo_url}
            alt="logo preview"
            style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', border: '1px solid var(--border, #ddd)' }}
          />
          <button type="button" className="btn" onClick={() => setF({ ...f, logo_url: '' })}>
            Remove logo
          </button>
        </div>
      )}
      <input
        placeholder="Quick replies — comma-separated (optional, e.g. Pricing, Support, Book demo)"
        value={f.quick_replies}
        onChange={(e) => setF({ ...f, quick_replies: e.target.value })}
      />
      <div className="row">
        <button className="btn" disabled={save.isPending}>Save appearance</button>
        {msg && <span className="muted" style={{ alignSelf: 'center' }}>{msg}</span>}
      </div>
    </form>
  );
}
