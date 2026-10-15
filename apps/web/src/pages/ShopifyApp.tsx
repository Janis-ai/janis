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
  | { kind: 'linked'; shop: string; agent: string | null; agentId: string | null; workspace: string | null; linkUrl: string; claimUrl: string; claimed: boolean }
  | { kind: 'uninstalled'; shop: string };

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
  // The App Bridge token doubles as the credential for /api/shopify/agent —
  // kept in memory only, sent on the setup-save POST.
  const sessionToken = useRef('');

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
            <p style={{ fontSize: 14, marginBottom: 4 }}>
              <strong>{state.shop}</strong> is connected
              {state.agent ? (
                <>
                  {' '}to <strong>{state.agent}</strong>
                </>
              ) : null}
              {state.workspace ? <span className="muted"> ({state.workspace})</span> : null}.
            </p>
            {embedOpened ? (
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
