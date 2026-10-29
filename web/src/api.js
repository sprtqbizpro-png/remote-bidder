import { getToken, clearSession } from './auth.js';

const API_BASE = import.meta.env.VITE_API_URL || '';

async function request(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.body && !(options.body instanceof FormData)
      ? { 'Content-Type': 'application/json' }
      : {}),
    ...options.headers,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });
  } catch (err) {
    const error = new Error(err.message || 'Network error');
    error.status = 0;
    error.network = true;
    throw error;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || res.statusText || 'Request failed');
    error.status = res.status;
    // Only drop the local session when the auth endpoint rejects the token.
    // Other 401s / network blips must not force a sign-in loop.
    if (res.status === 401 && path === '/api/auth/me' && token) {
      clearSession();
    }
    throw error;
  }
  return data;
}

export const api = {
  health: () => request('/api/health'),
  listJobs: () => request('/api/jobs'),
  getJob: (id) => request(`/api/jobs/${id}`),
  deleteJob: (id) => request(`/api/jobs/${id}`, { method: 'DELETE' }),
  listFixedAnswers: () => request('/api/answers/fixed'),
  saveFixedAnswer: (payload) =>
    request('/api/answers/fixed', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteFixedAnswer: (id) =>
    request(`/api/answers/fixed/${id}`, { method: 'DELETE' }),
  googleStatus: () => request('/api/auth/google/status'),
  googleAuthUrl: () => request('/api/auth/google'),
  disconnectGoogle: () =>
    request('/api/auth/google/disconnect', { method: 'POST' }),
  getSettings: () => request('/api/auth/settings'),
  saveSettings: (payload) =>
    request('/api/auth/settings', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  signin: (payload) =>
    request('/api/auth/signin', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  signout: () =>
    request('/api/auth/signout', {
      method: 'POST',
    }),
  me: () => request('/api/auth/me'),
  getProfile: () => request('/api/profile'),
  saveProfile: (payload) =>
    request('/api/profile', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  completeProfile: (payload) =>
    request('/api/profile/complete', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  listMembers: () => request('/api/members'),
  createMember: (payload) =>
    request('/api/members', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateMember: (id, payload) =>
    request(`/api/members/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteMember: (id) =>
    request(`/api/members/${id}`, {
      method: 'DELETE',
    }),
};
