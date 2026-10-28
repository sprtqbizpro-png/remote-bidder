import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { clearSession, getToken } from '../auth.js';

export default function RequireAuth() {
  const location = useLocation();
  const [status, setStatus] = useState(() => (getToken() ? 'checking' : 'guest'));

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
        await api.me();
        if (!cancelled) setStatus('authed');
      } catch {
        clearSession();
        if (!cancelled) setStatus('guest');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

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
