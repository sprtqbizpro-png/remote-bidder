import { NavLink, Outlet, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import JobsPage from './pages/JobsPage.jsx';
import JobDetailPage from './pages/JobDetailPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import MembersPage from './pages/MembersPage.jsx';
import SignInPage from './pages/SignInPage.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import { api } from './api.js';
import { clearSession, getStoredUser, getToken } from './auth.js';

function IconJobs() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function IconProfile() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 19.5c1.8-3.2 4.2-4.8 7-4.8s5.2 1.6 7 4.8" />
    </svg>
  );
}

function IconMembers() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="9" cy="8" r="3" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M3.5 19c1.5-2.8 3.6-4.2 5.5-4.2s4 1.4 5.5 4.2" />
      <path d="M14 14.2c1.4-.4 2.9.1 4.2 1.5.9 1 1.5 2.2 1.8 3.3" />
    </svg>
  );
}

function AppLayout() {
  const navigate = useNavigate();
  const user = getStoredUser();

  async function signOut() {
    try {
      if (getToken()) await api.signout();
    } catch {
      /* ignore */
    }
    clearSession();
    navigate('/signin', { replace: true });
  }

  return (
    <div className="jr-app">
      <aside className="jr-sidebar" aria-label="Main">
        <NavLink to="/" className="jr-sidebar-brand" end>
          <span className="jr-sidebar-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="20" height="20" fill="none">
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
          <span className="jr-sidebar-name">King Star</span>
        </NavLink>

        <nav className="jr-sidebar-nav">
          <NavLink to="/" end className={({ isActive }) => `jr-nav-item${isActive ? ' is-active' : ''}`}>
            <IconJobs />
            <span>Jobs</span>
          </NavLink>
          <NavLink
            to="/profile"
            className={({ isActive }) => `jr-nav-item${isActive ? ' is-active' : ''}`}
          >
            <IconProfile />
            <span>Profile</span>
          </NavLink>
          {user?.isOwner ? (
            <NavLink
              to="/members"
              className={({ isActive }) => `jr-nav-item${isActive ? ' is-active' : ''}`}
            >
              <IconMembers />
              <span>Members</span>
            </NavLink>
          ) : null}
        </nav>

        <div className="jr-sidebar-foot">
          {user?.email ? <p className="jr-sidebar-user">{user.email}</p> : null}
          <p className="jr-sidebar-hint">Extension autofills applications using this profile.</p>
          <div className="jr-sidebar-foot-actions">
            <NavLink to="/settings" className="jr-sidebar-settings">
              Settings
            </NavLink>
            <button type="button" className="jr-sidebar-signout" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="jr-main">
        <Outlet />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/members" element={<MembersPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
