import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { friendlyError } from '../lib/friendlyError';
import { usePageTitle } from '../lib/title';
import { BrandImg } from '../components/bits';

/**
 * Claim a provisioned Shopify workspace — zero-login installs create the
 * shop's workspace+agent ownerless; "Manage in Janis" in the embedded app
 * lands here (behind RequireAuth → login/signup → back) and POST
 * /api/shopify/claim makes the signed-in user admin + owner of it.
 */
export default function ShopifyClaim() {
  usePageTitle('Claim Shopify workspace');
  const [params] = useSearchParams();
  const code = params.get('code') ?? '';

  const claim = useQuery({
    queryKey: ['shopify-claim', code],
    queryFn: () =>
      api<{ ok: boolean; shop: string; workspace: string | null; agent_id: string | null }>(
        '/api/shopify/claim',
        {
          method: 'POST',
          body: JSON.stringify({ code }),
        },
      ),
    enabled: Boolean(code),
    retry: false,
    // The POST is idempotent — stale results are fine to reuse.
    staleTime: Infinity,
  });

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

        {claim.isLoading && <div className="muted">Claiming your store's workspace…</div>}
        {claim.error && (
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
      </div>
    </div>
  );
}
