import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { usePageTitle } from '../lib/title';
import { BrandImg } from '../components/bits';

export default function VerifyEmail() {
  usePageTitle('Confirm email');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'working' | 'error' | 'resent'>('working');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fired = useRef(false);

  useEffect(() => {
    if (!token || fired.current) {
      if (!token) setState('error');
      return;
    }
    fired.current = true; // StrictMode double-mount must not burn the token
    api('/auth/verify', { method: 'POST', body: JSON.stringify({ token }) })
      .then(async () => {
        await qc.invalidateQueries({ queryKey: ['me'] });
        navigate('/conversations');
      })
      .catch(() => setState('error'));
  }, [token, navigate, qc]);

  const resend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await api('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });
      setState('resent');
    } catch (err) {
      setState('error');
      if (err instanceof ApiError) console.error(err.message);
    }
    setBusy(false);
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="login-brand">
          <BrandImg alt="Janis" style={{ height: 40, marginBottom: 6 }} />
        </div>
        {state === 'working' && <p className="muted">Confirming your email…</p>}
        {state === 'resent' && (
          <p className="muted">If that address is registered, a fresh link is on its way.</p>
        )}
        {state === 'error' && (
          <>
            <div className="error">That link is expired or already used.</div>
            <form onSubmit={resend} style={{ marginTop: 12 }}>
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                style={{ width: '100%' }}
              />
              <button className="btn primary" disabled={busy} style={{ width: '100%', marginTop: 16 }}>
                {busy ? 'Sending…' : 'Send a new link'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
