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
  let res;
  try {
    res = await fetch(`${api}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const error = new Error(err.message || 'Network error');
    error.status = 0;
    error.network = true;
    throw error;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return data;
}

const JOBS_POLL_ALARM = 'ks-jobs-poll';
const JOBS_POLL_MINUTES = 0.5; // ~30s

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

async function ensureOffscreenDocument() {
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      });
      if (contexts?.length) return;
    }
  } catch {
    /* older Chrome */
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play a chime when an applied job is saved',
    });
  } catch (err) {
    // Already open or unsupported
    if (!/already exists|Only a single offscreen/i.test(String(err?.message || err))) {
      console.warn('Offscreen document failed', err);
    }
  }
}

async function playSaveSound() {
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PLAY_SAVE_SOUND' });
  } catch (err) {
    console.warn('Save sound failed', err);
  }
}

async function notifyAppliedJobSaved({ companyName, roleName, playSound = true } = {}) {
  const company = companyName || 'Company';
  const role = roleName || 'Role';
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
    setTimeout(() => {
      chrome.notifications.clear(id).catch(() => {});
    }, 10000);
  } catch (err) {
    console.warn('Notification failed', err);
  }
  if (playSound) await playSaveSound();
  return { ok: true };
}

async function syncKnownJobIds(jobs) {
  const ids = (Array.isArray(jobs) ? jobs : []).map((j) => j.id).filter(Boolean);
  await chrome.storage.local.set({
    hsKnownJobIds: ids,
    hsKnownJobsSyncedAt: Date.now(),
  });
  return ids;
}

async function pollAppliedJobsForNotifications() {
  const token = await getAuthToken();
  if (!token) return;
  try {
    const api = await getApiBase();
    const res = await fetch(`${api}/api/jobs`, { headers: await authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    const jobs = Array.isArray(data) ? data : [];
    const { hsKnownJobIds, hsJobsPollInitialized } = await chrome.storage.local.get({
      hsKnownJobIds: [],
      hsJobsPollInitialized: false,
    });
    const known = new Set(hsKnownJobIds || []);
    if (!hsJobsPollInitialized) {
      // First run: seed without notifying for historical jobs.
      await chrome.storage.local.set({ hsJobsPollInitialized: true });
      await syncKnownJobIds(jobs);
      return;
    }
    const newcomers = jobs.filter((j) => j?.id && !known.has(j.id));
    await syncKnownJobIds(jobs);
    // Newest first; notify at most a few to avoid spam
    for (const job of newcomers.slice(0, 3)) {
      await notifyAppliedJobSaved({
        companyName: job.companyName,
        roleName: job.roleName,
        playSound: true,
      });
    }
  } catch (err) {
    console.warn('Jobs poll failed', err);
  }
}

async function ensureJobsPollAlarm() {
  try {
    const existing = await chrome.alarms.get(JOBS_POLL_ALARM);
    if (!existing) {
      await chrome.alarms.create(JOBS_POLL_ALARM, {
        periodInMinutes: JOBS_POLL_MINUTES,
      });
    }
  } catch (err) {
    console.warn('Jobs poll alarm failed', err);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === JOBS_POLL_ALARM) {
    pollAppliedJobsForNotifications().catch(() => {});
  }
});

/**
 * After an install / update / reload, tabs that were already open still run the old content
 * script, which Chrome has cut off ("Extension context invalidated"). Inject the current scripts
 * so those tabs work without a manual page reload; the new instance replaces the stale panel.
 */
async function reinjectContentScripts() {
  const manifest = chrome.runtime.getManifest();
  const [main, frames] = manifest.content_scripts || [];
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null || tab.discarded) return;
      try {
        if (main?.css?.length) {
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: main.css });
        }
        if (frames?.js?.length) {
          await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: frames.js });
        }
        if (main?.js?.length) {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: main.js });
        }
      } catch {
        /* restricted pages (Web Store, PDF viewer, …) */
      }
    })
  );
}

chrome.runtime.onInstalled.addListener(() => {
  ensureJobsPollAlarm();
  reinjectContentScripts().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureJobsPollAlarm();
});

ensureJobsPollAlarm();

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

    case 'FRAMES_CALL': {
      // Run a HiddenStar frame function (frameCollect / frameFill / frameCollectFilled) inside the
      // tab's sub-frames — embedded application forms the top-frame panel cannot reach.
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: true, data: [] };
      const { fn, arg = null, frameIds } = message.payload || {};
      const target = frameIds?.length ? { tabId, frameIds } : { tabId, allFrames: true };
      let results = [];
      try {
        results = await chrome.scripting.executeScript({
          target,
          func: async (name, input) => {
            if (window.top === window) return null;
            const HS = window.HiddenStar;
            if (!HS || typeof HS[name] !== 'function') return null;
            return await HS[name](input);
          },
          args: [fn, arg],
        });
      } catch (err) {
        console.warn('FRAMES_CALL failed', err);
      }
      return {
        ok: true,
        data: (results || []).filter((r) => r && r.result).map((r) => ({ frameId: r.frameId, result: r.result })),
      };
    }

    case 'PARSE_RESUME_HISTORY': {
      const { openaiApiKey } = await chrome.storage.sync.get({ openaiApiKey: '' });
      const data = await apiJson('/api/resume/history', {
        method: 'POST',
        body: { ...message.payload, apiKey: openaiApiKey || undefined },
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
      // The key lets the server match learned questions by meaning and store a reusable phrasing
      const { openaiApiKey } = await chrome.storage.sync.get({ openaiApiKey: '' });
      const res = await fetch(`${api}/api/answers/fixed/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...message.payload, apiKey: openaiApiKey || undefined }),
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

      // Track locally so the poller doesn't re-notify this save.
      try {
        const { hsKnownJobIds } = await chrome.storage.local.get({ hsKnownJobIds: [] });
        const next = Array.from(new Set([...(hsKnownJobIds || []), data?.id].filter(Boolean)));
        await chrome.storage.local.set({
          hsKnownJobIds: next,
          hsJobsPollInitialized: true,
        });
      } catch {
        /* ignore */
      }

      // Always fire system notification + chime when a job is persisted.
      await notifyAppliedJobSaved({
        companyName: data?.companyName || message.payload?.companyName,
        roleName: data?.roleName || message.payload?.roleName,
        playSound: true,
      });

      return { ok: true, data };
    }

    case 'NOTIFY_APPLIED_SAVED': {
      return notifyAppliedJobSaved({
        companyName: message.payload?.companyName,
        roleName: message.payload?.roleName,
        playSound: message.payload?.playSound !== false,
      });
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
      // Do not call the API — self-signup is blocked; owner provisions members.
      return {
        ok: false,
        error: 'Signup is disabled. Ask the owner to add your account, then sign in.',
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
      } catch (err) {
        // Only drop the token when the API rejects it — not on network blips.
        if (err?.status === 401) {
          await chrome.storage.local.remove(['hsAuthToken', 'hsUser']);
          return { ok: true, data: { user: null, profileComplete: false } };
        }
        const { hsUser } = await chrome.storage.local.get({ hsUser: null });
        return {
          ok: true,
          data: {
            user: hsUser,
            profileComplete: !!hsUser,
            offline: true,
            error: err?.message || 'Auth check failed',
          },
        };
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
