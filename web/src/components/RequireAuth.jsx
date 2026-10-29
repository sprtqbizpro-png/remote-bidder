import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { clearSession, getStoredUser, getToken, setSession } from '../auth.js';

export default function RequireAuth() {
  const location = useLocation();
  const [status, setStatus] = useState(() => (getToken() ? 'checking' : 'guest'));

  // Validate the session once per mount (not on every route change).
  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    if (!token) {
      setStatus('guest');
      return undefined;
    }
    setStatus('checking');
    (async () => {
      try {
        const me = await api.me();
        if (me?.user) setSession({ token, user: me.user });
        if (!cancelled) setStatus('authed');
      } catch (err) {
        if (cancelled) return;
        // Real auth rejection → sign in again.
        if (err?.status === 401) {
          clearSession();
          setStatus('guest');
          return;
        }
        // Network / 5xx: keep existing session so a blip doesn't force logout.
        if (getToken() && getStoredUser()) {
          setStatus('authed');
          return;
        }
        setStatus('guest');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'checking') {
    return (
      <div className="jr-auth-loading" aria-busy="true">
        <div className="skeleton" style={{ height: 120, borderRadius: 16, maxWidth: 420 }} />
      </div>
    );
  }

  if (status !== 'authed') {
    return <Navigate to="/signin" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
