import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { BrandImg } from '../components/bits';

/**
 * The embedded app — loaded inside Shopify admin's iframe (App URL). App
 * Bridge v4 hands us a session-token JWT; /api/shopify/session verifies it
 * and answers with the shop's link state. Unlinked shops get a "Connect
 * your Janis workspace" button that opens the console link flow in a new
 * tab (cookies/session can't be relied on inside the iframe anyway).
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
  | { kind: 'linked'; shop: string; agent: string | null; agentId: string | null; workspace: string | null; linkUrl: string }
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
  // "Enable storefront chat" opens the theme editor in a NEW tab — this tab
  // would otherwise still show the CTA afterwards. Track the click (and
  // persist it per shop) so the view advances to next-steps.
  const [embedOpened, setEmbedOpened] = useState(false);

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
        const res = await api<{
          shop: string;
          state: string;
          link_url?: string;
          agent?: string | null;
          agent_id?: string | null;
          workspace?: string | null;
        }>('/api/shopify/session', { method: 'POST', body: JSON.stringify({ token }) });
        if (cancelled) return;
        if (res.state === 'linked') {
          setState({
            kind: 'linked',
            shop: res.shop,
            agent: res.agent ?? null,
            agentId: res.agent_id ?? null,
            workspace: res.workspace ?? null,
            linkUrl: res.link_url ?? '',
          });
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
              target="_blank"
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
                  href={state.agentId ? `/agents/${state.agentId}` : '/agents'}
                  target="_blank"
                  rel="noreferrer"
                >
                  Configure your agent
                </a>
                <a
                  className="btn"
                  style={{ display: 'block', marginTop: 10, textAlign: 'center' }}
                  href={`https://${state.shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/janis-chat`}
                  target="_blank"
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
                  target="_blank"
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

            {state.linkUrl ? (
              <p className="muted" style={{ fontSize: 12.5, marginTop: 14, textAlign: 'center' }}>
                Serving the wrong agent or workspace?{' '}
                <a href={state.linkUrl} target="_blank" rel="noreferrer">
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
