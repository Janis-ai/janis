import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { friendlyError } from '../lib/friendlyError';
import { usePageTitle } from '../lib/title';
import { BrandImg } from '../components/bits';

export default function ResetPassword() {
  usePageTitle('Reset password');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/auth/reset', { method: 'POST', body: JSON.stringify({ token, password }) });
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/conversations');
    } catch (err) {
      setError(err instanceof ApiError ? friendlyError(err.message).text : 'reset failed');
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-brand">
          <BrandImg alt="Janis" style={{ height: 40, marginBottom: 6 }} />
          <p className="muted">Choose a new password</p>
        </div>
        {!token ? (
          <div className="error">
            This reset link is missing its token — open the link from your email, or{' '}
            <a href="/login">request a fresh one</a>.
          </div>
        ) : (
          <>
            <label>New password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              style={{ width: '100%' }}
            />
            <label>Confirm password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              style={{ width: '100%' }}
            />
            {error && <div className="error">{error}</div>}
            <button className="btn primary" disabled={busy} style={{ width: '100%', marginTop: 20 }}>
              {busy ? 'Resetting…' : 'Reset password'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
