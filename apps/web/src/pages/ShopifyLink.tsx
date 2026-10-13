import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useAgents } from '../api/hooks';
import { friendlyError } from '../lib/friendlyError';
import { usePageTitle } from '../lib/title';
import { BrandImg } from '../components/bits';

/**
 * Console half of the Shopify link flow — the embedded app's "Connect your
 * Janis workspace" button opens this with a signed ?code. The admin picks
 * (or creates) the agent that serves the shop; POST /api/shopify/link
 * binds them and mirrors the shop's credentials into the agent's secrets.
 *
 * A merchant with no Janis account hits RequireAuth → login/signup → lands
 * back here (post-login-next) — that IS the channel's onboarding funnel.
 */
export default function ShopifyLink() {
  usePageTitle('Connect Shopify');
  const [params] = useSearchParams();
  const code = params.get('code') ?? '';
  const [agentId, setAgentId] = useState('');
  const [newName, setNewName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const info = useQuery({
    queryKey: ['shopify-link-info', code],
    queryFn: () =>
      api<{ shop: string; state: string; bound_agent_id: string | null }>(
        `/api/shopify/link-info?code=${encodeURIComponent(code)}`,
      ),
    enabled: Boolean(code),
    retry: false,
  });
  const agents = useAgents();

  const shop = info.data?.shop ?? '';
  const shopHandle = shop.replace(/\.myshopify\.com$/, '');
  const list = agents.data?.agents ?? [];
  const canSubmit = !busy && (creating ? newName.trim().length > 0 : agentId.length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      let id = agentId;
      if (creating) {
        // /bootstrap, not /agents — only the bootstrap route turns purpose
        // into a drafted config (system prompt, greeting, suggestions).
        const { agent } = await api<{ agent: { id: string } }>('/api/agents/bootstrap', {
          method: 'POST',
          body: JSON.stringify({
            name: newName.trim(),
            hosted: true,
            // purpose triggers the hosted draft generator — an agent made
            // here without it is an empty shell.
            ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
          }),
        });
        id = agent.id;
      }
      await api('/api/shopify/link', {
        method: 'POST',
        body: JSON.stringify({ code, agent_id: id }),
      });
      setDone(id);
    } catch (err) {
      setError(err instanceof ApiError ? friendlyError(err.message).text : 'link failed');
      setBusy(false);
    }
  };

  if (!code) {
    return (
      <div className="login-wrap">
        <div className="card login-card">
          <div className="error">
            Missing link code — open Janis from the Apps section of your Shopify admin to start the
            connection.
          </div>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="login-wrap">
        <div className="card login-card">
          <div className="login-brand">
            <BrandImg alt="Janis" style={{ height: 40, marginBottom: 6 }} />
          </div>
          <p>
            <strong>{shop}</strong> is connected — its credentials now live on the agent.
          </p>
          <a className="btn primary" style={{ display: 'block', textAlign: 'center' }} href={`/agents/${done}`}>
            Configure the agent
          </a>
          <a
            className="btn"
            style={{ display: 'block', margin: '8px 0 0', textAlign: 'center' }}
            href={`https://${shop}/admin`}
          >
            Back to Shopify admin
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="login-brand">
          <BrandImg alt="Janis" style={{ height: 40, marginBottom: 6 }} />
          <p className="muted">Connect Shopify</p>
        </div>

        {info.isLoading && <div className="muted">Checking the link…</div>}
        {info.error && (
          <div className="error">
            {info.error instanceof ApiError
              ? friendlyError(info.error.message).text
              : 'invalid or expired link — reopen the app in Shopify admin for a fresh one'}
          </div>
        )}

        {info.data && (
          <>
            <p>
              Which agent should serve <strong>{shop}</strong>?
            </p>
            {info.data.bound_agent_id && (
              <div className="muted" style={{ marginBottom: 10, fontSize: 13 }}>
                This shop is already connected — linking again rebinds it to the agent you pick.
              </div>
            )}
            {!creating && (
              <>
                {list.map((a) => (
                  <label key={a.id} className="row" style={{ display: 'flex', gap: 8, padding: '6px 0' }}>
                    <input
                      type="radio"
                      name="shopify-agent"
                      checked={agentId === a.id}
                      onChange={() => setAgentId(a.id)}
                    />
                    <span>{a.name}</span>
                  </label>
                ))}
                {list.length === 0 && (
                  <p className="muted" style={{ fontSize: 13 }}>
                    No agents in this workspace yet — create one for the shop.
                  </p>
                )}
                <button
                  className="btn"
                  style={{ width: '100%', marginTop: 6 }}
                  onClick={() => {
                    setCreating(true);
                    setNewName(newName || shopHandle);
                    if (!purpose) {
                      setPurpose(
                        `Storefront assistant for ${shop} — answer product questions, look up order status and tracking for customers, help with returns and exchanges, and hand off to the team when a human should take over.`,
                      );
                    }
                  }}
                >
                  Create a new agent
                </button>
              </>
            )}
            {creating && (
              <>
                <label>Agent name</label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={shopHandle}
                  style={{ width: '100%' }}
                />
                <label>What should it do for your customers?</label>
                <textarea
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  rows={4}
                  style={{ width: '100%' }}
                />
                {list.length > 0 && (
                  <button className="btn" style={{ width: '100%', marginTop: 6 }} onClick={() => setCreating(false)}>
                    Pick an existing agent instead
                  </button>
                )}
              </>
            )}
            {error && <div className="error">{error}</div>}
            <button className="btn primary" disabled={!canSubmit} onClick={submit} style={{ width: '100%', marginTop: 16 }}>
              {busy ? 'Connecting…' : `Connect ${shopHandle}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
