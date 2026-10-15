import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useMe } from '../api/hooks';
import { friendlyError } from '../lib/friendlyError';
import { usePageTitle } from '../lib/title';
import { BrandImg } from '../components/bits';

/**
 * Claim a provisioned Shopify workspace — zero-login installs create the
 * shop's workspace+agent ownerless; "Manage in Janis" in the embedded app
 * lands here (behind RequireAuth → login/signup → back) and POST
 * /api/shopify/claim makes the signed-in user admin + owner of it.
 *
 * Merchants who already have a Janis workspace get the consolidate choice
 * instead: switch to that workspace and run the normal link flow, which
 * rebinds the shop AND tears down the orphaned provisioned shell.
 */
export default function ShopifyClaim() {
  usePageTitle('Claim Shopify workspace');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const code = params.get('code') ?? '';
  const me = useMe();
  const [moveTarget, setMoveTarget] = useState('');
  const [moving, setMoving] = useState(false);

  // Existing non-grant workspaces — the consolidation candidates. The
  // provisioned workspace isn't claimable until after claim, so every entry
  // here predates it.
  const otherWs = (me.data?.workspaces ?? []).filter((w) => !w.agent_scoped);

  const claim = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; shop: string; workspace: string | null; agent_id: string | null }>(
        '/api/shopify/claim',
        { method: 'POST', body: JSON.stringify({ code }) },
      ),
  });

  // Auto-claim when there is nothing to consolidate into — a fresh signup
  // shouldn't have to read a choice card to proceed.
  useEffect(() => {
    if (me.data && !otherWs.length && code && !claim.isPending && !claim.data && !claim.isError) {
      claim.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data]);

  const moveInto = async () => {
    if (!moveTarget || moving) return;
    setMoving(true);
    try {
      await api('/auth/switch', { method: 'POST', body: JSON.stringify({ workspace_id: moveTarget }) });
      navigate(`/shopify-link?code=${encodeURIComponent(code)}`);
    } catch {
      setMoving(false);
    }
  };

  if (!code) {
    return (
      <div className="login-wrap">
        <div className="card login-card">
          <div className="error">
            Missing claim code — open Janis from the Apps section of your Shopify admin to get a
            fresh link.
          </div>
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

        {(!me.data || (otherWs.length === 0 && claim.isPending)) && (
          <div className="muted">Claiming your store's workspace…</div>
        )}
        {claim.isError && (
          <div className="error">
            {claim.error instanceof ApiError
              ? friendlyError(claim.error.message).text
              : 'claim failed — reopen the app in Shopify admin for a fresh link'}
          </div>
        )}

        {claim.data && (
          <>
            <p>
              <strong>{claim.data.shop}</strong> is connected to your Janis account
              {claim.data.workspace ? (
                <>
                  {' '}
                  — its assistant lives in <strong>{claim.data.workspace}</strong>
                </>
              ) : (
                ''
              )}
              .
            </p>
            <a
              className="btn primary"
              style={{ display: 'block', textAlign: 'center' }}
              href={claim.data.agent_id ? `/agents/${claim.data.agent_id}` : '/agents'}
            >
              Configure your agent
            </a>
            <p className="muted" style={{ fontSize: 13, marginTop: 16, textAlign: 'center' }}>
              <a href={`https://${claim.data.shop}/admin`}>Back to Shopify admin</a>
            </p>
          </>
        )}

        {me.data && otherWs.length > 0 && !claim.data && (
          <>
            <p>
              We already created a workspace for your store's assistant. Claim it — or move the
              store into one of your existing workspaces instead.
            </p>
            <button
              className="btn primary"
              style={{ width: '100%' }}
              onClick={() => claim.mutate()}
              disabled={claim.isPending}
            >
              {claim.isPending ? 'Claiming…' : 'Claim the new workspace'}
            </button>
            <p className="muted" style={{ fontSize: 13, margin: '14px 0 4px' }}>
              Or consolidate into an existing workspace:
            </p>
            <select
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">Choose a workspace…</option>
              {otherWs.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              className="btn"
              style={{ width: '100%', marginTop: 6 }}
              disabled={!moveTarget || moving}
              onClick={moveInto}
            >
              {moving ? 'Switching…' : 'Move the store there and pick an agent'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
