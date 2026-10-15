import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { BrandImg } from '../components/bits';

/**
 * The embedded app — loaded inside Shopify admin's iframe (App URL). App
 * Bridge v4 hands us a session-token JWT; /api/shopify/session verifies it,
 * auto-provisions a workspace+agent on first install (zero-login — the JWT
 * IS the credential), and answers with the shop's link state. Provisioned
 * shops see "Enable storefront chat" immediately; the ownerless workspace
 * is claimed later via claim_url when the merchant wants the console.
 * The manual link flow is now the fallback: deliberate unlinks and
 * provisioning failures still get a "Connect your Janis workspace" button
 * (target=_top escapes the iframe so the Janis session works). Theme-editor
 * links use _top too: the editor lives inside admin, so Back returns here.
 */

const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  pro: 'Pro',
  scale: 'Scale',
  internal: 'Internal',
};

declare global {
  interface Window {
    shopify?: { idToken?: () => Promise<string> };
  }
}

type SessionState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'unlinked'; shop: string; link_url: string }
  | {
      kind: 'setup';
      shop: string;
      agentId: string | null;
      name: string;
      purpose: string;
      greeting: string;
      linkUrl: string;
    }
  | {
      kind: 'linked';
      shop: string;
      agent: string | null;
      agentId: string | null;
      workspace: string | null;
      linkUrl: string;
      claimUrl: string;
      claimed: boolean;
      plan: string;
      usage: { used: number; included: number; capped: boolean } | null;
      billing: { status?: string; plan?: string } | null;
      embedEnabled: boolean | null;
      plans: { key: string; name: string; price_cents: number; included_messages: number }[];
    }
  | { kind: 'uninstalled'; shop: string };

type InboxConv = {
  id: string;
  state: string;
  is_unread: boolean;
  last_message_preview: string | null;
  last_message_at: string | null;
  user_profile: { name?: string; first_name?: string; email?: string } | null;
};

type InboxMsg = {
  id: string;
  direction: string;
  text: string;
  payload?: Record<string, unknown>;
  created_at: string;
};

const convName = (cv: InboxConv) =>
  cv.user_profile?.name || cv.user_profile?.first_name || cv.user_profile?.email || 'Visitor';

async function loadAppBridge(apiKey: string): Promise<NonNullable<Window['shopify']> | null> {
  // The meta tag MUST exist before the script evaluates — v4 reads its
  // config (api key + host param) off it at init.
  const meta = document.createElement('meta');
  meta.name = 'shopify-api-key';
  meta.content = apiKey;
  document.head.appendChild(meta);
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.shopify.com/shopifycloud/app-bridge.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Shopify App Bridge failed to load'));
    document.head.appendChild(s);
  });
  // The script tag firing onload ≠ the global being initialized — v4
  // attaches window.shopify asynchronously. Poll briefly before giving up.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (window.shopify?.idToken) return window.shopify;
    await new Promise((r) => setTimeout(r, 100));
  }
  const keys = window.shopify ? Object.keys(window.shopify).join(',') || '(empty)' : 'missing';
  const host = new URLSearchParams(window.location.search).get('host');
  console.warn('[shopify-app] App Bridge did not initialize', { host: !!host, keys });
  return null;
}

export default function ShopifyApp() {
  const [state, setState] = useState<SessionState>({ kind: 'loading' });
  const [apiKey, setApiKey] = useState(''); // client_id — theme-editor deep link
  const [tick, setTick] = useState(0); // "I've connected" re-check
  // "Enable storefront chat" navigates the tab to the theme editor — when
  // they come back this page would otherwise still show the CTA. Track the
  // click (persisted per shop) so the view advances to next-steps.
  const [embedOpened, setEmbedOpened] = useState(false);
  // Setup-card edit fields — initialized from the session payload when the
  // setup state first renders.
  const [setupName, setSetupName] = useState('');
  const [setupPurpose, setSetupPurpose] = useState('');
  const [setupGreeting, setSetupGreeting] = useState('');
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState('');
  // The App Bridge token doubles as the credential for /api/shopify/agent
  // and /api/shopify/plan — kept in memory only, sent on those POSTs.
  const sessionToken = useRef('');
  const [subscribing, setSubscribing] = useState('');
  const [planError, setPlanError] = useState('');

  // In-frame inbox — the session token is the credential for
  // /api/shopify/inbox/*. Staff identity comes from the JWT on the API
  // side; the client just sends the token.
  const [tab, setTab] = useState<'home' | 'inbox'>('home');
  const [inbox, setInbox] = useState<InboxConv[] | null>(null);
  const [thread, setThread] = useState<{
    conv: InboxConv;
    messages: InboxMsg[];
    hasMore: boolean;
  } | null>(null);
  const threadId = useRef<string | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [inboxError, setInboxError] = useState('');

  const loadThread = async (id: string) => {
    const res = await api<{
      conversation: InboxConv;
      messages: InboxMsg[];
      has_more: boolean;
    }>('/api/shopify/inbox/thread', {
      method: 'POST',
      body: JSON.stringify({ token: sessionToken.current, conversation_id: id }),
    });
    setThread({ conv: res.conversation, messages: res.messages, hasMore: res.has_more });
  };

  useEffect(() => {
    if (state.kind !== 'linked' || tab !== 'inbox') return;
    let dead = false;
    const loadList = async () => {
      try {
        const res = await api<{ conversations: InboxConv[] }>('/api/shopify/inbox', {
          method: 'POST',
          body: JSON.stringify({ token: sessionToken.current }),
        });
        if (!dead) setInbox(res.conversations);
      } catch {
        /* stale list beats an empty one */
      }
      if (threadId.current) {
        try {
          await loadThread(threadId.current);
        } catch {
          /* keep the last snapshot */
        }
      }
    };
    void loadList();
    const t = setInterval(() => void loadList(), 8000);
    return () => {
      dead = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind, tab]);

  const openThread = async (id: string) => {
    threadId.current = id;
    setInboxError('');
    try {
      await loadThread(id);
    } catch (err) {
      setInboxError(err instanceof Error ? err.message : 'could not load thread');
    }
  };

  const closeThread = () => {
    threadId.current = null;
    setThread(null);
    setReply('');
  };

  const sendReply = async () => {
    const id = threadId.current;
    const text = reply.trim();
    if (!id || !text || busy) return;
    setBusy(true);
    setInboxError('');
    try {
      await api('/api/shopify/inbox/reply', {
        method: 'POST',
        body: JSON.stringify({ token: sessionToken.current, conversation_id: id, text }),
      });
      setReply('');
      await loadThread(id);
    } catch (err) {
      setInboxError(err instanceof Error ? err.message : 'reply failed');
    } finally {
      setBusy(false);
    }
  };

  const resumeAgent = async () => {
    const id = threadId.current;
    if (!id || busy) return;
    setBusy(true);
    setInboxError('');
    try {
      await api('/api/shopify/inbox/resume', {
        method: 'POST',
        body: JSON.stringify({ token: sessionToken.current, conversation_id: id }),
      });
      await loadThread(id);
    } catch (err) {
      setInboxError(err instanceof Error ? err.message : 'resume failed');
    } finally {
      setBusy(false);
    }
  };

  const subscribe = async (plan: string) => {
    if (subscribing) return;
    setSubscribing(plan);
    setPlanError('');
    try {
      const res = await api<{ confirmation_url: string }>('/api/shopify/plan', {
        method: 'POST',
        body: JSON.stringify({ token: sessionToken.current, plan }),
      });
      // Shopify's own approval page — a deliberate top-level navigation.
      window.open(res.confirmation_url, '_top');
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'could not start subscription');
      setSubscribing('');
    }
  };

  useEffect(() => {
    if (state.kind === 'setup') {
      setSetupName(state.name);
      setSetupPurpose(state.purpose);
      setSetupGreeting(state.greeting);
    }
  }, [state]);

  const approveSetup = async () => {
    if (state.kind !== 'setup' || setupSaving) return;
    setSetupSaving(true);
    setSetupError('');
    try {
      // Only send changed fields — an unchanged purpose must not trigger a
      // re-draft.
      const body: Record<string, string> = {};
      if (setupName.trim() && setupName.trim() !== state.name) body.name = setupName.trim();
      if (setupPurpose.trim() !== state.purpose) body.purpose = setupPurpose.trim();
      if (setupGreeting.trim() !== state.greeting) body.greeting = setupGreeting.trim();
      if (Object.keys(body).length) {
        await api('/api/shopify/agent', {
          method: 'POST',
          body: JSON.stringify({ token: sessionToken.current, ...body }),
        });
      }
      localStorage.setItem(`janis:setup-done:${state.shop}`, '1');
      setTick((t) => t + 1); // reload → linked card
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'save failed');
      setSetupSaving(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.get('shop')) {
      setState({
        kind: 'error',
        message: 'Open this app from the Apps section of your Shopify admin — the shop context is missing.',
      });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api<{ api_key: string }>('/api/shopify/app-config');
        setApiKey(cfg.api_key);
        const bridge = await loadAppBridge(cfg.api_key);
        // Managed install also drops a session-token JWT on the iframe URL
        // (?id_token=) — use it when App Bridge didn't attach its global.
        const token = bridge ? await bridge.idToken!() : params.get('id_token');
        if (!token) throw new Error('no session token — open this app inside Shopify admin');
        sessionToken.current = token;
        const res = await api<{
          shop: string;
          state: string;
          link_url?: string;
          claim_url?: string;
          claimed?: boolean;
          agent?: string | null;
          agent_id?: string | null;
          workspace?: string | null;
          purpose?: string | null;
          greeting?: string | null;
          plan?: string;
          usage?: { used: number; included: number; capped: boolean } | null;
          billing?: { status?: string; plan?: string } | null;
          embed_enabled?: boolean | null;
          plans?: { key: string; name: string; price_cents: number; included_messages: number }[];
        }>('/api/shopify/session', { method: 'POST', body: JSON.stringify({ token }) });
        if (cancelled) return;
        if (res.state === 'linked') {
          // Auto-provisioned shops (claimed=false) get the brief-approval
          // step in place of the old link wizard — editable name, purpose
          // and greeting. Once approved (flag persisted per shop) or once
          // the workspace is claimed, loads land on the normal linked card.
          const setupDone =
            localStorage.getItem(`janis:setup-done:${res.shop}`) === '1';
          if (!res.claimed && !setupDone) {
            setState({
              kind: 'setup',
              shop: res.shop,
              agentId: res.agent_id ?? null,
              name: res.agent ?? '',
              purpose:
                res.purpose ??
                `You are the AI shopping assistant for ${res.shop}, a Shopify store. Help visitors find products, check order status, and answer questions about shipping, returns and store policies — and help them complete purchases.`,
              greeting: res.greeting ?? '',
              linkUrl: res.link_url ?? '',
            });
          } else {
            setState({
              kind: 'linked',
              shop: res.shop,
              agent: res.agent ?? null,
              agentId: res.agent_id ?? null,
              workspace: res.workspace ?? null,
              linkUrl: res.link_url ?? '',
              claimUrl: res.claim_url ?? '',
              claimed: res.claimed ?? false,
              plan: res.plan ?? 'free',
              usage: res.usage ?? null,
              billing: res.billing ?? null,
              embedEnabled: res.embed_enabled ?? null,
              plans: res.plans ?? [],
            });
          }
          if (localStorage.getItem(`janis:embed-opened:${res.shop}`) === '1') setEmbedOpened(true);
        } else if (res.state === 'uninstalled') {
          setState({ kind: 'uninstalled', shop: res.shop });
        } else {
          setState({ kind: 'unlinked', shop: res.shop, link_url: res.link_url ?? '' });
        }
      } catch (err) {
        if (!cancelled) {
          setState({ kind: 'error', message: err instanceof Error ? err.message : 'install failed' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="login-brand">
          <BrandImg alt="Janis" style={{ height: 40, marginBottom: 6 }} />
          <p className="muted">Human backup for AI agents</p>
        </div>

        {state.kind === 'loading' && <div className="muted">Connecting to Janis…</div>}

        {state.kind === 'error' && (
          <>
            <div className="error">{state.message}</div>
            <button className="btn" style={{ width: '100%', marginTop: 12 }} onClick={() => setTick((t) => t + 1)}>
              Try again
            </button>
          </>
        )}

        {state.kind === 'unlinked' && (
          <>
            <p>
              Connect <strong>{state.shop}</strong> to a Janis workspace to power your storefront
              assistant — order lookups, product answers, and a chat widget for your customers.
            </p>
            <a
              className="btn primary"
              style={{ display: 'block', marginTop: 8, textAlign: 'center' }}
              href={state.link_url}
              target="_top"
              rel="noreferrer"
            >
              Connect your Janis workspace
            </a>
            <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
              Already connected?{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); setTick((t) => t + 1); }}>
                Refresh this app
              </a>
            </p>
          </>
        )}

        {state.kind === 'setup' && (
          <>
            <p style={{ fontSize: 14, marginBottom: 4 }}>
              <strong>{state.shop}</strong> — your assistant is ready. Check the brief and adjust
              anything:
            </p>
            <label>Assistant name</label>
            <input
              value={setupName}
              onChange={(e) => setSetupName(e.target.value)}
              style={{ width: '100%' }}
            />
            <label>What should it do for your customers?</label>
            <textarea
              value={setupPurpose}
              onChange={(e) => setSetupPurpose(e.target.value)}
              rows={5}
              style={{ width: '100%' }}
            />
            <label>Greeting shoppers see</label>
            <input
              value={setupGreeting}
              onChange={(e) => setSetupGreeting(e.target.value)}
              placeholder="Hi there! How can I help you today?"
              style={{ width: '100%' }}
            />
            {setupError && <div className="error">{setupError}</div>}
            <button
              className="btn primary"
              style={{ width: '100%', marginTop: 12 }}
              onClick={approveSetup}
              disabled={setupSaving || !setupName.trim() || !setupPurpose.trim()}
            >
              {setupSaving ? 'Saving…' : 'Looks good — continue'}
            </button>
            {state.linkUrl ? (
              <p className="muted" style={{ fontSize: 12.5, marginTop: 12, textAlign: 'center' }}>
                Rather use an existing agent?{' '}
                <a href={state.linkUrl} target="_top" rel="noreferrer">
                  Pick or create one
                </a>
              </p>
            ) : null}
          </>
        )}

        {state.kind === 'linked' && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <button
                className={tab === 'home' ? 'btn primary' : 'btn'}
                style={{ flex: 1 }}
                onClick={() => setTab('home')}
              >
                Store
              </button>
              <button
                className={tab === 'inbox' ? 'btn primary' : 'btn'}
                style={{ flex: 1 }}
                onClick={() => setTab('inbox')}
              >
                Inbox
              </button>
            </div>

            {tab === 'inbox' ? (
              thread ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button className="btn" onClick={closeThread}>
                      ←
                    </button>
                    <strong style={{ fontSize: 14 }}>{convName(thread.conv)}</strong>
                    {thread.conv.state === 'human' && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        · agent paused
                      </span>
                    )}
                    {thread.conv.state === 'needs_human' && (
                      <span style={{ fontSize: 12, color: '#b45309' }}>· asked for a human</span>
                    )}
                  </div>
                  <div
                    style={{
                      maxHeight: 320,
                      overflowY: 'auto',
                      margin: '10px 0',
                      textAlign: 'left',
                    }}
                  >
                    {thread.messages.map((m) => {
                      if (m.direction === 'system' || m.payload?.internal) {
                        return (
                          <div
                            key={m.id}
                            className="muted"
                            style={{ fontSize: 11, textAlign: 'center', margin: '4px 0' }}
                          >
                            {m.text}
                          </div>
                        );
                      }
                      const mine = m.direction !== 'in';
                      return (
                        <div
                          key={m.id}
                          style={{ margin: '4px 0', textAlign: mine ? 'right' : 'left' }}
                        >
                          <span
                            style={{
                              display: 'inline-block',
                              maxWidth: '85%',
                              padding: '6px 10px',
                              borderRadius: 12,
                              background: mine ? '#dcf0ff' : '#f1f1f4',
                              // The page is dark-themed — inherited text is
                              // white-on-light without an explicit color.
                              color: '#1f2937',
                              fontSize: 13,
                              textAlign: 'left',
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {m.direction === 'human' ? (
                              <span style={{ fontSize: 11, display: 'block', color: '#6b7280' }}>
                                Staff reply
                              </span>
                            ) : null}
                            {m.text}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void sendReply();
                        }
                      }}
                      placeholder="Reply as staff…"
                      style={{ flex: 1 }}
                    />
                    <button
                      className="btn primary"
                      onClick={() => void sendReply()}
                      disabled={busy || !reply.trim()}
                    >
                      Send
                    </button>
                  </div>
                  {inboxError && <div className="error">{inboxError}</div>}
                  {thread.conv.state === 'human' ? (
                    <button
                      className="btn"
                      style={{ width: '100%', marginTop: 8 }}
                      onClick={() => void resumeAgent()}
                      disabled={busy}
                    >
                      Resume agent on this chat
                    </button>
                  ) : null}
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    {thread.conv.state === 'human'
                      ? 'Replies come from your staff account — the agent stays paused and auto-resumes after ~10 minutes idle.'
                      : 'Replying pauses the agent on this chat — it auto-resumes after ~10 minutes.'}
                  </p>
                </>
              ) : (
                <>
                  {!inbox ? (
                    <div className="muted">Loading conversations…</div>
                  ) : inbox.length === 0 ? (
                    <div className="muted" style={{ fontSize: 13 }}>
                      No conversations yet — shopper chats will show up here.
                    </div>
                  ) : (
                    <div
                      style={{
                        textAlign: 'left',
                        maxHeight: 380,
                        overflowY: 'auto',
                        margin: '0 -6px',
                      }}
                    >
                      {inbox.map((cv) => (
                        <button
                          key={cv.id}
                          onClick={() => void openThread(cv.id)}
                          style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            padding: '8px 6px',
                            border: 'none',
                            background: 'none',
                            borderBottom: '1px solid #eee',
                            cursor: 'pointer',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <strong style={{ fontSize: 13 }}>{convName(cv)}</strong>
                            {cv.is_unread ? (
                              <span style={{ color: '#2563eb', fontSize: 12 }}>● new</span>
                            ) : cv.state === 'needs_human' ? (
                              <span style={{ color: '#b45309', fontSize: 12 }}>needs you</span>
                            ) : null}
                          </div>
                          <div
                            className="muted"
                            style={{
                              fontSize: 12,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {cv.last_message_preview ?? ''}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {inboxError && <div className="error">{inboxError}</div>}
                </>
              )
            ) : (
              <>
            <p style={{ fontSize: 14, marginBottom: 4 }}>
              <strong>{state.shop}</strong> is connected
              {state.agent ? (
                <>
                  {' '}to <strong>{state.agent}</strong>
                </>
              ) : null}
              {state.workspace ? <span className="muted"> ({state.workspace})</span> : null}.
            </p>
            {state.usage?.capped ? (
              <div className="error" style={{ marginTop: 10 }}>
                The free plan's monthly message cap is reached — shoppers see an offline notice
                until you pick a plan below.
              </div>
            ) : null}
            {(state.embedEnabled ?? embedOpened) ? (
              // Returning visit — embed link was opened once, so the CTA
              // flips to day-2 actions: tune the agent, edit the embed.
              <>
                <a
                  className="btn primary"
                  style={{ display: 'block', marginTop: 8, textAlign: 'center' }}
                  // Unclaimed (auto-provisioned) workspaces route through the
                  // claim flow first — a direct /agents link would land the
                  // merchant on a workspace they aren't a member of.
                  href={state.claimed ? (state.agentId ? `/agents/${state.agentId}` : '/agents') : state.claimUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Configure your agent
                </a>
                <a
                  className="btn"
                  style={{ display: 'block', marginTop: 10, textAlign: 'center' }}
                  href={`https://${state.shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/janis-chat`}
                  target="_top"
                  rel="noreferrer"
                >
                  Edit storefront chat
                </a>
                <p className="muted" style={{ fontSize: 12.5, marginTop: 10, textAlign: 'center' }}>
                  <a href={`https://${state.shop}`} target="_blank" rel="noreferrer">
                    Open your storefront ↗
                  </a>
                </p>
              </>
            ) : (
              // Fresh link — the storefront embed is THE next step; nothing
              // else competes with it.
              <>
                <p className="muted" style={{ fontSize: 13 }}>
                  One step left — turn on the storefront chat.
                </p>
                <a
                  className="btn primary"
                  style={{ display: 'block', marginTop: 8, textAlign: 'center' }}
                  href={`https://${state.shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/janis-chat`}
                  target="_top"
                  rel="noreferrer"
                  onClick={() => {
                    setEmbedOpened(true);
                    localStorage.setItem(`janis:embed-opened:${state.shop}`, '1');
                  }}
                >
                  Enable storefront chat
                </a>
                <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 8px' }}>
                  Opens your theme editor — toggle on the "Janis chat" app embed and hit{' '}
                  <strong>Save</strong>; the bubble appears on your storefront immediately.
                </p>
              </>
            )}

            {state.plan === 'free' ? (
              <div
                style={{
                  marginTop: 16,
                  padding: '12px',
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  textAlign: 'left',
                }}
              >
                <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 4px' }}>
                  Plan: Free
                  {state.usage
                    ? ` — ${state.usage.used.toLocaleString()} / ${state.usage.included.toLocaleString()} messages this month`
                    : ''}
                </p>
                {state.plans.map((p) => (
                  <button
                    key={p.key}
                    className="btn"
                    style={{ width: '100%', marginTop: 6 }}
                    disabled={Boolean(subscribing)}
                    onClick={() => subscribe(p.key)}
                  >
                    {subscribing === p.key
                      ? 'Opening Shopify…'
                      : `${p.name} — $${(p.price_cents / 100).toFixed(0)}/mo · ${p.included_messages.toLocaleString()} messages`}
                  </button>
                ))}
                {planError && <div className="error">{planError}</div>}
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Billed by Shopify — approve the charge on the next screen.
                </p>
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>
                {PLAN_NAMES[state.plan] ?? state.plan} plan
                {state.usage ? ` · ${state.usage.used.toLocaleString()} messages this month` : ''}
                {state.billing?.status === 'PENDING' ? ' · subscription awaiting approval' : ''}
              </p>
            )}

            {!state.claimed && state.claimUrl ? (
              <p className="muted" style={{ fontSize: 12.5, marginTop: 12, textAlign: 'center' }}>
                <a href={state.claimUrl} target="_blank" rel="noreferrer">
                  Manage this store in the Janis console →
                </a>
              </p>
            ) : null}
            {state.linkUrl ? (
              <p className="muted" style={{ fontSize: 12.5, marginTop: 14, textAlign: 'center' }}>
                Serving the wrong agent or workspace?{' '}
                <a href={state.linkUrl} target="_top" rel="noreferrer">
                  Switch or create an agent
                </a>
              </p>
            ) : null}
              </>
            )}
          </>
        )}

        {state.kind === 'uninstalled' && (
          <p className="muted">
            <strong>{state.shop}</strong> — this install was removed. Re-add the app from the
            Shopify App Store to reconnect.
          </p>
        )}
      </div>
    </div>
  );
}
