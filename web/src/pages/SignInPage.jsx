import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { getToken, setSession, getStoredUser } from '../auth.js';

const REMEMBER_EMAIL_KEY = 'hs_remember_email';
const DEFAULT_EMAIL = 'anthonyfait.digital@gmail.com';

export default function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState(
    () => localStorage.getItem(REMEMBER_EMAIL_KEY) || DEFAULT_EMAIL
  );
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const token = getToken();
  const from = location.state?.from?.pathname || '/';

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    (async () => {
      try {
        await api.me();
        if (!cancelled) navigate(from, { replace: true });
      } catch {
        /* stay on sign-in */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, from, navigate]);

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const data = await api.signin({ email: email.trim(), password });
      setSession({ token: data.token, user: data.user });
      if (remember) localStorage.setItem(REMEMBER_EMAIL_KEY, email.trim());
      else localStorage.removeItem(REMEMBER_EMAIL_KEY);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err.message || 'Sign in failed');
    } finally {
      setSaving(false);
    }
  }

  if (token && getStoredUser()) {
    return <Navigate to={from} replace />;
  }

  return (
    <div className="jr-signin-page">
      <div className="jr-signin-card">
        <div className="jr-signin-brand">
          <span className="jr-signin-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
              <path
                d="M6.2 18.2c3.4-1.2 6.6-4.1 8.8-7.6 1.1 3.4 3.2 6.2 6.4 8.1-2.8.4-5.2 1.6-7 3.6-1.9-1.7-4.7-2.9-8.2-4.1z"
                fill="#0b3d32"
              />
              <path
                d="M21.4 10.2c1.6 2.2 2.2 4.4 1.8 6.5 2.4-1.1 4.2-2.8 5.2-5.1-2.3.1-4.6-.2-7-1.4z"
                fill="#0b3d32"
              />
            </svg>
          </span>
          <div>
            <p className="jr-signin-eyebrow">King Star</p>
            <h1>Sign in</h1>
          </div>
        </div>
        <p className="jr-signin-lede">
          Use your account to open jobs, profile, and settings.
        </p>

        <form className="jr-signin-form" onSubmit={onSubmit}>
          <label className="jr-signin-field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>

          <label className="jr-signin-field">
            <span>Password</span>
            <div className="jr-signin-password">
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
              />
              <button
                type="button"
                className="jr-signin-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          <label className="jr-signin-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Remember email on this device</span>
          </label>

          {error ? <p className="jr-signin-error">{error}</p> : null}

          <button type="submit" className="jr-signin-submit" disabled={saving}>
            {saving ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
