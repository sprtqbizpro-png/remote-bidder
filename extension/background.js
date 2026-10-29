const DEFAULT_API = 'http://localhost:3847';
const DEFAULT_WEB = 'http://localhost:5280';

async function getApiBase() {
  const { apiBaseUrl } = await chrome.storage.sync.get({ apiBaseUrl: DEFAULT_API });
  return (apiBaseUrl || DEFAULT_API).replace(/\/$/, '');
}

function normalizeBaseUrl(url, fallback) {
  const value = String(url || '').trim().replace(/\/$/, '');
  return value || fallback;
}

/**
 * Resolve web app URL for profile deep-links.
 * Prefer an explicit extension setting, otherwise use FRONTEND_URL from the API.
 */
async function getWebBase() {
  const { webBaseUrl, apiBaseUrl } = await chrome.storage.sync.get({
    webBaseUrl: '',
    apiBaseUrl: DEFAULT_API,
  });
  const explicit = String(webBaseUrl || '').trim();
  if (explicit) return normalizeBaseUrl(explicit, DEFAULT_WEB);

  try {
    const api = normalizeBaseUrl(apiBaseUrl, DEFAULT_API);
    const res = await fetch(`${api}/api/auth/settings`);
    const data = await res.json().catch(() => ({}));
    if (data?.frontendUrl) return normalizeBaseUrl(data.frontendUrl, DEFAULT_WEB);
  } catch {
    /* API may be offline — fall back */
  }
  return DEFAULT_WEB;
}

async function getAuthToken() {
  const { hsAuthToken } = await chrome.storage.local.get({ hsAuthToken: null });
  return hsAuthToken || null;
}

async function authHeaders(extra = {}) {
  const token = await getAuthToken();
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function apiJson(path, { method = 'GET', body } = {}) {
  const api = await getApiBase();
  const headers = await authHeaders(
    body !== undefined ? { 'Content-Type': 'application/json' } : {}
  );
  const res = await fetch(`${api}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

async function handleMessage(message, sender = {}) {
  const api = await getApiBase();

  switch (message.type) {
    case 'GET_SETTINGS': {
      const settings = await chrome.storage.sync.get({
        apiBaseUrl: DEFAULT_API,
        webBaseUrl: '',
        openaiApiKey: '',
        autoFillEnabled: true,
      });
      if (!settings.webBaseUrl) {
        settings.webBaseUrl = await getWebBase();
      }
      return { ok: true, settings };
    }

    case 'SAVE_SETTINGS': {
      const next = { ...(message.settings || {}) };
      if (next.webBaseUrl !== undefined) {
        next.webBaseUrl = String(next.webBaseUrl || '').trim().replace(/\/$/, '');
      }
      if (next.apiBaseUrl !== undefined) {
        next.apiBaseUrl = String(next.apiBaseUrl || '').trim().replace(/\/$/, '') || DEFAULT_API;
      }
      await chrome.storage.sync.set(next);
      return { ok: true };
    }

    case 'OPENAI_STATUS': {
      const { openaiApiKey } = await chrome.storage.sync.get({ openaiApiKey: '' });
      const extensionKey = !!(openaiApiKey && String(openaiApiKey).trim());
      let serverConfigured = false;
      try {
        const data = await apiJson('/api/auth/settings');
        serverConfigured = !!data.openaiConfigured;
      } catch {
        /* API may be offline */
      }
      const configured = extensionKey || serverConfigured;
      return {
        ok: true,
        data: {
          configured,
          extensionKey,
          serverConfigured,
          source: extensionKey ? 'extension' : serverConfigured ? 'server' : null,
        },
      };
    }

    case 'GENERATE_ANSWERS': {
      const { openaiApiKey } = await chrome.storage.sync.get({ openaiApiKey: '' });
      // Include auth so generate can load the signed-in profile for autofill
      const data = await apiJson('/api/answers/generate', {
        method: 'POST',
        body: {
          ...message.payload,
          apiKey: openaiApiKey || undefined,
        },
      });
      return { ok: true, data };
    }

    case 'SAVE_FIXED_ANSWER': {
      const res = await fetch(`${api}/api/answers/fixed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message.payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save fixed answer failed');
      return { ok: true, data };
    }

    case 'SAVE_FIXED_ANSWERS_BULK': {
      const res = await fetch(`${api}/api/answers/fixed/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message.payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bulk save failed');
      return { ok: true, data };
    }

    case 'LIST_FIXED_ANSWERS': {
      const res = await fetch(`${api}/api/answers/fixed`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'List failed');
      return { ok: true, data };
    }

    case 'DELETE_FIXED_ANSWER': {
      const id = message.payload?.id;
      if (!id) throw new Error('id is required');
      const res = await fetch(`${api}/api/answers/fixed/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      return { ok: true, data };
    }

    case 'ENSURE_MAMMOTH': {
      const tabId = sender.tab?.id;
      if (!tabId) throw new Error('No active tab for document parser');
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['preview/vendor/mammoth.browser.min.js'],
      });
      return { ok: true };
    }

    case 'SAVE_RESUME_LOCAL': {
      const payload = message.payload || {};
      if (!payload.dataUrl || !payload.fileName) {
        throw new Error('Resume file data is required');
      }
      const savedResume = {
        fileName: payload.fileName,
        mimeType: payload.mimeType || 'application/pdf',
        dataUrl: payload.dataUrl,
        resumeText: payload.resumeText || '',
        webViewLink: payload.webViewLink || null,
        fileId: payload.fileId || null,
        savedAt: new Date().toISOString(),
      };
      await chrome.storage.local.set({ savedResume });
      return {
        ok: true,
        data: {
          fileName: savedResume.fileName,
          mimeType: savedResume.mimeType,
          webViewLink: savedResume.webViewLink,
          fileId: savedResume.fileId,
          savedAt: savedResume.savedAt,
          hasText: !!savedResume.resumeText,
        },
      };
    }

    case 'GET_RESUME_LOCAL': {
      const { savedResume } = await chrome.storage.local.get({ savedResume: null });
      return { ok: true, data: savedResume };
    }

    case 'CLEAR_RESUME_LOCAL': {
      await chrome.storage.local.remove('savedResume');
      return { ok: true };
    }

    case 'OPEN_RESUME_PREVIEW': {
      const { savedResume } = await chrome.storage.local.get({ savedResume: null });
      if (savedResume?.dataUrl) {
        const url = chrome.runtime.getURL('preview/resume.html');
        const tab = await chrome.tabs.create({ url, active: true });
        return { ok: true, data: { tabId: tab.id, mode: 'local' } };
      }
      if (savedResume?.webViewLink || message.payload?.webViewLink) {
        const link = savedResume?.webViewLink || message.payload.webViewLink;
        const tab = await chrome.tabs.create({ url: link, active: true });
        return { ok: true, data: { tabId: tab.id, mode: 'drive' } };
      }
      throw new Error('No resume saved yet. Upload a resume first.');
    }

    case 'UPLOAD_RESUME': {
      const payload = message.payload || {};
      let dataUrl = payload.dataUrl || null;
      let fileName = payload.fileName || null;
      let mimeType = payload.mimeType || null;

      // Prefer reading the already-saved local resume (avoids huge message payloads
      // and works after panel remount when content only has the file name).
      const { savedResume } = await chrome.storage.local.get({ savedResume: null });
      if ((!dataUrl || payload.useStored) && savedResume?.dataUrl) {
        dataUrl = savedResume.dataUrl;
        fileName = fileName || savedResume.fileName;
        mimeType = mimeType || savedResume.mimeType;
      }
      if (!dataUrl) {
        throw new Error(
          'No resume file found. Use Replace Resume to attach Anthony_Fait_Flossy.docx (or your file) first.'
        );
      }
      fileName = fileName || 'resume.pdf';
      mimeType = mimeType || mimeFromFileName(fileName);

      const form = new FormData();
      const blob = dataURLtoBlob(dataUrl, mimeType);
      form.append('resume', blob, fileName);
      if (payload.companyName) form.append('companyName', payload.companyName);
      if (payload.roleName) form.append('roleName', payload.roleName);

      const res = await fetch(`${api}/api/resume/upload`, {
        method: 'POST',
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Resume upload to Google Drive failed');

      // Persist Drive link onto the local resume record
      if (savedResume?.dataUrl) {
        await chrome.storage.local.set({
          savedResume: {
            ...savedResume,
            fileName,
            mimeType,
            webViewLink: data.webViewLink || savedResume.webViewLink || null,
            fileId: data.fileId || savedResume.fileId || null,
            savedAt: new Date().toISOString(),
          },
        });
      }

      return { ok: true, data };
    }

    case 'LIST_APPLIED_JOBS': {
      const res = await fetch(`${api}/api/jobs`, {
        headers: await authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'List jobs failed');
      return { ok: true, data: Array.isArray(data) ? data : [] };
    }

    case 'SAVE_APPLIED_JOB': {
      const res = await fetch(`${api}/api/jobs`, {
        method: 'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(message.payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save job failed');
      return { ok: true, data };
    }

    case 'NOTIFY_APPLIED_SAVED': {
      const company = message.payload?.companyName || 'Company';
      const role = message.payload?.roleName || 'Role';
      const id = `ks-applied-${Date.now()}`;
      try {
        await chrome.notifications.create(id, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'King Star — Application saved',
          message: `${role} at ${company} was added to Applied jobs.`,
          priority: 2,
          requireInteraction: false,
          silent: false,
        });
        // Auto-clear after a bit so the tray doesn’t fill up
        setTimeout(() => {
          chrome.notifications.clear(id).catch(() => {});
        }, 8000);
      } catch (err) {
        console.warn('Notification failed', err);
      }
      return { ok: true };
    }

    case 'HEALTH': {
      const res = await fetch(`${api}/api/health`);
      const data = await res.json();
      return { ok: res.ok, data };
    }

    case 'EXTRACT_JOB': {
      const { openaiApiKey } = await chrome.storage.sync.get({ openaiApiKey: '' });
      const res = await fetch(`${api}/api/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...message.payload,
          apiKey: openaiApiKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Extract failed');
      return { ok: true, data };
    }

    /** Persist current job draft across tabs until apply/reset */
    case 'GET_DRAFT_JOB': {
      const { draftJob } = await chrome.storage.local.get({ draftJob: null });
      return { ok: true, data: draftJob };
    }

    case 'SAVE_DRAFT_JOB': {
      const draft = {
        ...(message.payload || {}),
        updatedAt: new Date().toISOString(),
      };
      await chrome.storage.local.set({ draftJob: draft });
      return { ok: true, data: draft };
    }

    case 'CLEAR_DRAFT_JOB': {
      await chrome.storage.local.remove('draftJob');
      return { ok: true };
    }

    case 'AUTH_SIGNUP': {
      return {
        ok: false,
        error: 'Signup is disabled. Please sign in with an existing account.',
      };
    }

    case 'AUTH_SIGNIN': {
      const data = await apiJson('/api/auth/signin', {
        method: 'POST',
        body: message.payload || {},
      });
      await chrome.storage.local.set({
        hsAuthToken: data.token,
        hsUser: data.user,
      });
      return { ok: true, data };
    }

    case 'AUTH_SIGNOUT': {
      try {
        await apiJson('/api/auth/signout', { method: 'POST', body: {} });
      } catch {
        /* ignore */
      }
      await chrome.storage.local.remove(['hsAuthToken', 'hsUser']);
      return { ok: true };
    }

    case 'AUTH_ME': {
      const token = await getAuthToken();
      if (!token) return { ok: true, data: { user: null, profileComplete: false } };
      try {
        const data = await apiJson('/api/auth/me');
        await chrome.storage.local.set({ hsUser: data.user });
        return { ok: true, data };
      } catch {
        await chrome.storage.local.remove(['hsAuthToken', 'hsUser']);
        return { ok: true, data: { user: null, profileComplete: false } };
      }
    }

    case 'GET_PROFILE': {
      const data = await apiJson('/api/profile');
      return { ok: true, data };
    }

    case 'SAVE_PROFILE': {
      const data = await apiJson('/api/profile', {
        method: 'PUT',
        body: message.payload || {},
      });
      return { ok: true, data };
    }

    case 'COMPLETE_PROFILE': {
      const data = await apiJson('/api/profile/complete', {
        method: 'POST',
        body: message.payload || {},
      });
      return { ok: true, data };
    }

    case 'OPEN_WEB_PROFILE': {
      const web = await getWebBase();
      const token = await getAuthToken();
      const url = new URL(`${web}/profile`);
      if (token) url.searchParams.set('token', token);
      await chrome.tabs.create({ url: url.toString() });
      return { ok: true, url: url.toString() };
    }

    case 'GET_WEB_BASE': {
      const web = await getWebBase();
      return { ok: true, webBaseUrl: web };
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

function mimeFromFileName(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (n.endsWith('.doc')) return 'application/msword';
  if (n.endsWith('.rtf')) return 'application/rtf';
  if (n.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

function dataURLtoBlob(dataUrl, fallbackMime) {
  const raw = String(dataUrl || '');
  const comma = raw.indexOf(',');
  if (comma < 0) throw new Error('Invalid resume data');
  const header = raw.slice(0, comma);
  const base64 = raw.slice(comma + 1);
  const fromHeader = (header.match(/:(.*?);/) || [])[1] || '';
  const mime =
    fromHeader && fromHeader !== 'application/octet-stream'
      ? fromHeader
      : fallbackMime || fromHeader || 'application/octet-stream';
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
