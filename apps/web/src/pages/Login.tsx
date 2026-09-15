import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const providers = useQuery({
    queryKey: ['auth-providers'],
    queryFn: () => api<{ google: boolean; slack: boolean }>('/auth/providers'),
    staleTime: Infinity,
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'login failed');
    }
  };

  const oauthError = params.get('error');
  const anyProvider = providers.data?.google || providers.data?.slack;

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>Janis</h1>
        <p className="muted" style={{ textAlign: 'center' }}>Human oversight for AI agents</p>
        {anyProvider && (
          <div className="oauth-buttons">
            {providers.data?.google && (
              <a className="btn" href="/auth/google">Continue with Google</a>
            )}
            {providers.data?.slack && (
              <a className="btn" href="/auth/slack">Continue with Slack</a>
            )}
            <div className="oauth-divider"><span>or</span></div>
          </div>
        )}
        <label>Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ width: '100%' }} />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ width: '100%' }} />
        {(error || oauthError) && <div className="error">{error || oauthError}</div>}
        <button className="btn primary" style={{ width: '100%', marginTop: 20 }}>Sign in</button>
      </form>
    </div>
  );
}
