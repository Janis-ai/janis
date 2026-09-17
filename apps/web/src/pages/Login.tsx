import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';

const GoogleLogo = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18z"/>
    <path fill="#FBBC05" d="M3.97 10.71a5.4 5.4 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3.01-2.33z"/>
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.9 11.42 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.67 5.16 6.66 3.58 9 3.58z"/>
  </svg>
);

const SlackLogo = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
    <path fill="#E01E5A" d="M5.04 15.16a2.52 2.52 0 1 1-2.52-2.52h2.52v2.52zm1.27 0a2.52 2.52 0 0 1 5.04 0v6.31a2.52 2.52 0 1 1-5.04 0v-6.31z"/>
    <path fill="#36C5F0" d="M8.83 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52H8.83zm0 1.27a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 1 1 0-5.04h6.31z"/>
    <path fill="#2EB67D" d="M18.96 8.84a2.52 2.52 0 1 1 2.52 2.52h-2.52V8.84zm-1.27 0a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 1 1 5.04 0v6.32z"/>
    <path fill="#ECB22E" d="M15.17 18.96a2.52 2.52 0 1 1-2.52 2.52v-2.52h2.52zm0-1.27a2.52 2.52 0 0 1 0-5.04h6.31a2.52 2.52 0 1 1 0 5.04h-6.31z"/>
  </svg>
);

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
      navigate('/conversations');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'login failed');
    }
  };

  const oauthError = params.get('error');
  const anyProvider = providers.data?.google || providers.data?.slack;

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-brand">
          <h1>Janis</h1>
          <p className="muted">Human oversight for AI agents</p>
        </div>
        {anyProvider && (
          <div className="oauth-buttons">
            {providers.data?.google && (
              <a className="btn oauth-btn" href="/auth/google">
                <GoogleLogo /> Continue with Google
              </a>
            )}
            {providers.data?.slack && (
              <a className="btn oauth-btn" href="/auth/slack">
                <SlackLogo /> Continue with Slack
              </a>
            )}
            <div className="oauth-divider"><span>or continue with email</span></div>
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
