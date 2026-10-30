/**
 * King Star content script — Jobright-style setup gate + apply workflow.
 */
(function () {
  const HS = window.HiddenStar;
  // A previous instance whose extension context died (extension reloaded/updated) must not block
  // the fresh one the background re-injects.
  if (!HS || (window.__hsContentLoaded && window.__hsAlive?.())) return;
  window.__hsContentLoaded = true;
  // This instance's own check — window.__hsAlive is overwritten by a newer instance
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  window.__hsAlive = alive;
  // Remove the dead instance's panel/dock/dialogs (their listeners can no longer reach the extension)
  document
    .querySelectorAll('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')
    .forEach((n) => n.remove());

  let panel = null;
  let dock = null;
  let infoDialog = null;
  let jobDialog = null;
  let jobInfo = null;
  let lastResumeLink = null;
  let lastResumeFileId = null;
  let lastResumeName = null;
  let lastResumeMime = null;
  let lastResumeDataUrl = null;
  let lastResumeText = null;
  let extractInFlight = false;
  let fixedCount = null;
  let draftSaveTimer = null;
  let session = { user: null, profileComplete: false, completedSteps: {} };
  let profileDraft = HS.Setup ? HS.Setup.emptyProfile() : null;
  let view = 'boot'; // boot | setup | auth | profile | apply
  let authMode = 'signin';
  let profileStep = 'personal';
  let infoTab = 'personal';
  let dockTop = null;
  const steps = { extract: false, autofill: false, resume: false, save: false };
  let progressItemsCache = [];
  let progressExpanded = false;
  let progressBusy = false;
  let autofillCancelled = false;
  let appliedSaveInFlight = false;
  let appliedSavedKeys = new Set();
  let applySubmitWatchBound = false;
  let answerLearnBusy = false;
  let answerLearnSig = '';
  let answerLearnEnabled = false;
  /** Baseline field values after autofill — used to detect user edits for "updated". */
  let progressValueBaseline = new Map();
  /**
   * Click-sourced Yes/No answers. DOM polls often miss Ashby teal selection and would
   * incorrectly clear the board back to "todo" — trust these until they expire.
   */
  let progressChoiceOverrides = new Map();
  let panelRestoreInFlight = false;
  let openPanelInFlight = null;

  let contextDead = false;

  function isContextInvalidated(err) {
    return /extension context invalidated|receiving end does not exist/i.test(String(err?.message || err));
  }

  /**
   * The extension was reloaded/updated while this tab stayed open: this copy of the script can no
   * longer talk to it. If the background already injected a fresh copy, step aside; otherwise
   * tell the user to reload the page instead of showing the raw Chrome error.
   */
  function handleContextInvalidated() {
    if (contextDead) return;
    contextDead = true;
    stopAnswerLearningWatch?.();
    const fresh = Array.from(document.querySelectorAll('#hs-panel')).some((p) => p !== panel);
    if (fresh) {
      [panel, dock, infoDialog, jobDialog].forEach((n) => n?.remove?.());
      return;
    }
    const el = document.getElementById('hs-status');
    if (el) {
      el.classList.remove('hs-ok', 'hs-busy');
      el.classList.add('hs-error');
      el.innerHTML =
        'King Star was updated. <button type="button" class="hs-reload-page">Reload this page</button> to continue.';
      el.querySelector('.hs-reload-page')?.addEventListener('click', () => location.reload());
    }
  }

  /** chrome.storage.local that degrades quietly once the extension context is gone. */
  function storageSet(items) {
    try {
      if (alive()) chrome.storage.local.set(items);
      else handleContextInvalidated();
    } catch {
      handleContextInvalidated();
    }
  }
  function storageGet(defaults, cb) {
    try {
      if (alive()) return chrome.storage.local.get(defaults, cb);
      handleContextInvalidated();
    } catch {
      handleContextInvalidated();
    }
    cb(defaults);
  }

  async function send(type, payload) {
    if (contextDead || !alive()) {
      handleContextInvalidated();
      return { ok: false, error: 'King Star was updated — reload this page to continue.' };
    }
    try {
      return await chrome.runtime.sendMessage({ type, payload });
    } catch (err) {
      if (isContextInvalidated(err) && !alive()) {
        handleContextInvalidated();
        return { ok: false, error: 'King Star was updated — reload this page to continue.' };
      }
      throw err;
    }
  }

  function updateSteps() {
    if (!panel) return;
    panel.querySelectorAll('[data-step]').forEach((el) => {
      const key = el.getAttribute('data-step');
      el.classList.toggle('is-done', !!steps[key]);
    });
  }

  function setBusy(ids, busy) {
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = !!busy;
    });
  }

  function setStatus(msg, isError, tone) {
    const el = document.getElementById('hs-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.remove('hs-error', 'hs-ok', 'hs-busy');
    if (isError) el.classList.add('hs-error');
    else if (tone === 'ok') el.classList.add('hs-ok');
    else if (tone === 'busy') el.classList.add('hs-busy');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------- Dock (screenshot 2) ---------- */

  function mountUiRoot(el) {
    if (!el) return;
    const root = document.documentElement;
    if (el.parentElement !== root) root.appendChild(el);
  }

  /** Host SPAs often wipe injected nodes — recreate if detached. */
  function isMounted(el) {
    return !!(el && el.isConnected && document.documentElement.contains(el));
  }

  function ensureDock() {
    if (dock && isMounted(dock)) return dock;
    const reuse = dock && dock.id === 'hs-dock';
    if (!reuse) {
      dock = document.createElement('div');
      dock.id = 'hs-dock';
      dock.innerHTML = `
      <button type="button" class="hs-dock-dismiss" title="Hide" aria-label="Hide King Star">×</button>
      <div class="hs-dock-pill">
        <button type="button" class="hs-dock-main" title="Open King Star" aria-label="Open King Star">
          <span class="hs-dock-logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="22" height="22" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6.2 18.2c3.4-1.2 6.6-4.1 8.8-7.6 1.1 3.4 3.2 6.2 6.4 8.1-2.8.4-5.2 1.6-7 3.6-1.9-1.7-4.7-2.9-8.2-4.1z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>
              <path d="M21.4 10.2c1.6 2.2 2.2 4.4 1.8 6.5 2.4-1.1 4.2-2.8 5.2-5.1-2.3.1-4.6-.2-7-1.4z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>
              <path d="M8.5 20.8c2.8 1.6 4.6 3.6 5.2 5.8-.2-2.2-1.4-4.4-3.2-6.2-.6.1-1.3.2-2 .4z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/>
            </svg>
          </span>
        </button>
        <div class="hs-dock-handle" title="Drag" aria-label="Drag">
          <span></span><span></span><span></span>
          <span></span><span></span><span></span>
        </div>
      </div>
    `;
      dock.querySelector('.hs-dock-main').addEventListener('click', () => openPanel());
      dock.querySelector('.hs-dock-dismiss').addEventListener('click', (e) => {
        e.stopPropagation();
        dock.classList.add('hs-dock-hidden');
        storageSet({ hsDockHidden: true });
      });
      enableDockDrag(dock.querySelector('.hs-dock-handle'));
    }
    mountUiRoot(dock);

    storageGet({ hsDockTop: null, hsDockHidden: false }, (res) => {
      if (!dock) return;
      if (typeof res.hsDockTop === 'number') {
        dockTop = res.hsDockTop;
        dock.style.top = `${dockTop}px`;
        dock.style.bottom = 'auto';
      }
      // Never leave the dock permanently hidden when the panel is also closed
      if (res.hsDockHidden && !panel?.classList.contains('hs-open')) {
        dock.classList.add('hs-dock-hidden');
      }
    });

    return dock;
  }

  function showDock() {
    ensureDock();
    dock.classList.remove('hs-dock-hidden');
    storageSet({ hsDockHidden: false });
  }

  const PANEL_WIDTH = 400;

  function applySplitLayout(open) {
    const root = document.documentElement;
    root.style.setProperty('--hs-panel-w', `${PANEL_WIDTH}px`);
    // Jobright-style split on desktop; overlay fallback on narrow viewports
    const useSplit = open && window.innerWidth > 720;
    root.classList.toggle('hs-split-open', useSplit);
  }

  function setPanelOpen(open) {
    ensurePanel();
    ensureDock();
    // Re-attach if a host SPA removed our nodes
    mountUiRoot(panel);
    mountUiRoot(dock);
    if (infoDialog) mountUiRoot(infoDialog);
    if (jobDialog) mountUiRoot(jobDialog);

    panel.classList.toggle('hs-open', !!open);
    applySplitLayout(!!open);
    dock.classList.toggle('hs-dock-panel-open', !!open);
    if (open) {
      // Opening the panel always clears a stale "dock dismissed" flag
      dock.classList.remove('hs-dock-hidden');
      storageSet({ hsDockHidden: false });
    } else {
      closeInfoDialog();
      closeJobDialog();
      // If split margin was left behind with no panel, clear it
      if (!panel.classList.contains('hs-open')) applySplitLayout(false);
      showDock();
    }
  }

  function enableDockDrag(handle) {
    let dragging = false;
    let startY = 0;
    let startTop = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const dy = clientY - startY;
      const next = Math.min(window.innerHeight - 80, Math.max(12, startTop + dy));
      dock.style.top = `${next}px`;
      dock.style.bottom = 'auto';
      dockTop = next;
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      dock.classList.remove('hs-dock-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      if (typeof dockTop === 'number') storageSet({ hsDockTop: dockTop });
    };

    const onDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      dock.classList.add('hs-dock-dragging');
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      startY = clientY;
      startTop = dock.getBoundingClientRect().top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
    };

    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });
  }

  /* ---------- Panel shell ---------- */

  function wirePanelChrome(p) {
    p.querySelector('.hs-collapse')?.addEventListener('click', () => {
      setPanelOpen(false);
      showDock();
    });

    p.querySelector('#hs-progress-view')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-progress-action]');
      if (!btn) return;
      e.preventDefault();
      const action = btn.getAttribute('data-progress-action');
      if (action === 'cancel') collapseProgressBoard({ cancelAutofill: true });
      else if (action === 'close') collapseProgressBoard();
      else if (action === 'expand') expandProgressBoard();
    });
  }

  function ensurePanel() {
    if (panel && isMounted(panel)) return panel;

    if (!panel || panel.id !== 'hs-panel') {
      panel = document.createElement('div');
      panel.id = 'hs-panel';
      panel.innerHTML = `
      <div class="hs-header">
        <div class="hs-brand-wrap">
          <div class="hs-logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6.2 18.2c3.4-1.2 6.6-4.1 8.8-7.6 1.1 3.4 3.2 6.2 6.4 8.1-2.8.4-5.2 1.6-7 3.6-1.9-1.7-4.7-2.9-8.2-4.1z" fill="#fff" stroke="#0b3d32" stroke-width="1.2" stroke-linejoin="round"/>
              <path d="M21.4 10.2c1.6 2.2 2.2 4.4 1.8 6.5 2.4-1.1 4.2-2.8 5.2-5.1-2.3.1-4.6-.2-7-1.4z" fill="#fff" stroke="#0b3d32" stroke-width="1.2" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="hs-brand-text">
            <div class="hs-brand">King Star</div>
            <div class="hs-brand-sub">Autofill · apply · track</div>
          </div>
        </div>
        <button type="button" class="hs-collapse" title="Hide panel" aria-label="Hide panel">›</button>
      </div>
      <div class="hs-body" id="hs-view"></div>
      <div id="hs-progress-view" class="jr-progress" hidden></div>
      <p class="hs-status" id="hs-status" role="status" aria-live="polite"></p>
    `;
      wirePanelChrome(panel);
    }

    mountUiRoot(panel);
    ensureInfoDialog();
    ensureJobDialog();
    if (infoDialog) mountUiRoot(infoDialog);
    if (jobDialog) mountUiRoot(jobDialog);

    return panel;
  }

  function ensureInfoDialog() {
    if (infoDialog && document.contains(infoDialog)) return infoDialog;
    infoDialog = document.createElement('div');
    infoDialog.id = 'hs-info-dialog';
    infoDialog.className = 'jr-dialog';
    infoDialog.hidden = true;
    infoDialog.innerHTML = `
      <button type="button" class="jr-dialog-backdrop" data-action="close-info-dialog" aria-label="Close dialog"></button>
      <div class="jr-dialog-panel jr-info-panel" role="dialog" aria-modal="true" aria-labelledby="hs-info-title">
        <header class="jr-dialog-head jr-info-head">
          <button type="button" class="jr-dialog-x" data-action="close-info-dialog" aria-label="Close">×</button>
          <h2 id="hs-info-title">Your Autofill Information</h2>
        </header>
        <div class="jr-info-top" id="hs-info-top"></div>
        <div class="jr-dialog-body">
          <nav class="jr-dialog-nav" aria-label="Profile sections">
            <button type="button" class="jr-nav-item is-active" data-info-tab="personal">
              <span class="jr-nav-dot" data-nav-dot="personal" aria-hidden="true"></span>
              <span class="jr-nav-label">Personal</span>
            </button>
            <button type="button" class="jr-nav-item" data-info-tab="education">
              <span class="jr-nav-dot" data-nav-dot="education" aria-hidden="true"></span>
              <span class="jr-nav-label">Education</span>
            </button>
            <button type="button" class="jr-nav-item" data-info-tab="equalEmployment">
              <span class="jr-nav-dot" data-nav-dot="equalEmployment" aria-hidden="true"></span>
              <span class="jr-nav-label">Equal Employment</span>
            </button>
          </nav>
          <div class="jr-dialog-content" id="hs-info-content"></div>
        </div>
        <footer class="jr-dialog-foot">
          <button type="button" class="jr-dialog-update" id="hs-info-update">Update</button>
        </footer>
      </div>`;
    document.documentElement.appendChild(infoDialog);

    infoDialog.querySelectorAll('[data-action="close-info-dialog"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        closeInfoDialog();
      });
    });
    return infoDialog;
  }

  function filled(v) {
    return !!(v && String(v).trim());
  }

  function profileFieldStats(draft) {
    const p = draft?.personal || {};
    const edu = draft?.education?.[0] || {};
    const ee = draft?.equalEmployment || {};
    const required = [
      filled(p.firstName),
      filled(p.lastName),
      filled(p.email),
      filled(p.phone),
      filled(p.addressLine),
      filled(edu.schoolName),
    ];
    const optional = [
      filled(p.middleName),
      filled(p.linkedinUrl),
      filled(p.githubUrl),
      filled(p.portfolioUrl),
      filled(edu.major),
      filled(edu.degreeType),
      filled(ee.gender),
      filled(ee.race),
    ];
    const reqDone = required.filter(Boolean).length;
    const optDone = optional.filter(Boolean).length;
    return {
      reqDone,
      reqTotal: required.length,
      optDone,
      optTotal: optional.length,
      pct: Math.round((reqDone / required.length) * 100),
      sections: {
        personal: filled(p.firstName) && filled(p.lastName) && filled(p.email) && filled(p.phone),
        education: filled(edu.schoolName),
        equalEmployment: filled(ee.gender) || filled(ee.race) || filled(ee.veteran),
      },
    };
  }

  function companyInitial(name) {
    const t = String(name || 'J').trim();
    return (t[0] || 'J').toUpperCase();
  }

  function renderInfoTop() {
    const top = document.getElementById('hs-info-top');
    if (!top) return;
    const stats = profileFieldStats(profileDraft);
    const company = jobInfo?.companyName || '';
    const role = jobInfo?.roleName || '';
    const hasJob = !!(company || role);
    const host = (() => {
      try {
        return new URL(jobInfo?.sourceUrl || location.href).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();

    top.innerHTML = `
      ${
        hasJob
          ? `<div class="jr-info-job-card">
              <div class="jr-info-job-row">
                <div class="jr-info-job-brand">
                  <span class="jr-info-job-logo" aria-hidden="true">${escapeHtml(companyInitial(company))}</span>
                  <div class="jr-info-job-brand-text">
                    <div class="jr-info-job-company">${escapeHtml(company || 'Company')}</div>
                    <div class="jr-info-job-host">${escapeHtml(host || 'Current page')}</div>
                  </div>
                </div>
                <div class="jr-info-score" title="Profile readiness for this application">
                  <span class="jr-info-score-ring" style="--hs-score:${stats.pct}"></span>
                  <span class="jr-info-score-val">${stats.pct}%</span>
                </div>
              </div>
              <div class="jr-info-job-title">${escapeHtml(role || 'Job on this page')}</div>
              <div class="jr-info-job-meta">Autofill profile · ${escapeHtml(host || 'local')}</div>
            </div>`
          : `<div class="jr-info-job-card jr-info-job-card-empty">
              <div class="jr-info-job-title">Your saved autofill profile</div>
              <div class="jr-info-job-meta">Add a job on this page to see match context.</div>
            </div>`
      }
      <div class="jr-info-progress">
        <div class="jr-info-progress-row">
          <span>${stats.reqDone}/${stats.reqTotal} required fields filled · ${stats.pct}%</span>
        </div>
        <div class="jr-info-progress-track" aria-hidden="true">
          <div class="jr-info-progress-fill" style="width:${stats.pct}%"></div>
        </div>
      </div>`;

    infoDialog?.querySelectorAll('[data-nav-dot]').forEach((dot) => {
      const key = dot.getAttribute('data-nav-dot');
      dot.classList.toggle('is-done', !!stats.sections[key]);
    });
  }

  function applyHtml() {
    const company = jobInfo?.companyName || '';
    const role = jobInfo?.roleName || '';
    const hasJob = !!(company && role);
    const resumeName = lastResumeName || '';
    const hasResume = !!(lastResumeDataUrl || lastResumeLink);
    return `
      <div class="jr-apply">
        <div class="jr-apply-hero-card">
          <button type="button" id="hs-add-job" class="jr-add-job">
            <span class="jr-add-job-label">Add a new job for this page</span>
            <span class="jr-spark" aria-hidden="true">✦</span>
          </button>
          <p class="jr-add-sub">Extract title, company, URL, and description from this page.</p>
          <div id="hs-job-card" class="jr-job-summary" ${hasJob ? '' : 'hidden'}>
            <div class="jr-job-summary-main">
              <div class="jr-job-company" id="hs-job-company">${escapeHtml(company)}</div>
              <div class="jr-job-role" id="hs-job-role">${escapeHtml(role)}</div>
              <div class="jr-job-meta" id="hs-extract-meta"></div>
            </div>
          </div>
          <div class="jr-job-toolbar" role="group" aria-label="Job actions">
            <button type="button" id="hs-copy-job" class="jr-job-copy" title="Copy job title and description" ${hasJob ? '' : 'disabled'}>
              <span class="jr-job-copy-icon" aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </span>
              <span class="jr-job-copy-label">Copy</span>
            </button>
            <div class="jr-job-actions-end">
              <button type="button" id="hs-edit-job" class="jr-job-edit" title="Edit job details">Edit</button>
              <button type="button" id="hs-reset" class="jr-job-reset" title="Clear job draft">Reset</button>
            </div>
          </div>
        </div>

        <button type="button" id="hs-autofill" class="jr-autofill-cta">Autofill</button>
        <div class="jr-credits" id="hs-openai-status-row">
          <span class="jr-credits-left" id="hs-openai-status">OpenAI: checking…</span>
          <button type="button" class="jr-credits-link" id="hs-openai-key-hint" title="Set key in the extension popup">Set API key</button>
        </div>

        <div class="jr-menu" id="hs-apply-menu">
          <button type="button" class="jr-menu-row" data-action="open-info-dialog">
            <span class="jr-menu-icon" aria-hidden="true">📁</span>
            <span class="jr-menu-label">Your Autofill Information</span>
            <span class="jr-menu-chevron">›</span>
          </button>

          <div class="jr-menu-block jr-resume-block ${hasResume ? 'has-resume' : ''}">
            <button type="button" class="jr-menu-row jr-resume-row" id="hs-resume" title="Choose a resume file">
              <span class="jr-menu-icon jr-resume-icon" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="8" y1="13" x2="16" y2="13"/>
                  <line x1="8" y1="17" x2="14" y2="17"/>
                </svg>
              </span>
              <span class="jr-resume-copy">
                <span class="jr-menu-label">${hasResume ? 'Replace Resume' : 'Upload Resume'}</span>
                <span class="jr-menu-file" id="hs-resume-name">${escapeHtml(resumeName)}</span>
              </span>
              <span class="jr-menu-chevron">›</span>
            </button>
            <button type="button" class="jr-resume-preview-btn" id="hs-resume-preview" ${hasResume ? '' : 'hidden'}>
              <span class="jr-resume-preview-label">Preview resume</span>
              <span class="jr-resume-preview-arrow" aria-hidden="true">↗</span>
            </button>
          </div>

          <div class="jr-menu-block">
            <button type="button" class="jr-menu-row" id="hs-cover" disabled title="Coming soon">
              <span class="jr-menu-icon" aria-hidden="true">✉️</span>
              <span class="jr-menu-label">Upload Cover Letter</span>
              <span class="jr-menu-chevron">›</span>
            </button>
            <button type="button" class="jr-secondary-btn" id="hs-cover-gen" disabled>Generate Cover Letter</button>
          </div>
        </div>

        <button type="button" id="hs-save" class="jr-mark-applied">Save applied job</button>
        <p class="jr-save-hint">Saves to the web app, uploads resume + a job-info .txt to Google Drive, and remembers answers. Also runs on submit confirmation.</p>

        <button type="button" class="jr-apply-back" data-action="back-setup">← Setup</button>

        <!-- Hidden draft fields (kept for extract/persist) -->
        <div class="jr-hidden-fields" hidden>
          <input id="hs-company" type="text" />
          <input id="hs-role" type="text" />
          <input id="hs-url" type="text" />
          <div id="hs-desc-view"></div>
          <textarea id="hs-desc"></textarea>
          <button type="button" id="hs-desc-toggle"></button>
          <button type="button" id="hs-extract"></button>
          <button type="button" id="hs-extract-ai"></button>
          <button type="button" id="hs-fixed-save"></button>
          <input id="hs-fixed-q" /><input id="hs-fixed-a" />
          <div id="hs-fixed-list"></div>
          <span id="hs-fixed-count"></span>
        </div>
      </div>`;
  }

  function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function withTimeout(promise, ms, fallback) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(fallback), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function panelViewRoot() {
    ensurePanel();
    return panel?.querySelector?.('#hs-view') || document.getElementById('hs-view');
  }

  function showPanelPlaceholder(message = 'Loading King Star…') {
    const root = panelViewRoot();
    if (!root) return;
    root.innerHTML = `
      <div class="hs-panel-loading" role="status" aria-live="polite">
        <div class="hs-panel-loading-spin" aria-hidden="true"></div>
        <p class="hs-panel-loading-text">${escapeHtml(message)}</p>
      </div>`;
  }

  function showPanelFallback(message) {
    const root = panelViewRoot();
    if (!root) return;
    root.innerHTML = `
      <div class="hs-panel-loading">
        <p class="hs-panel-loading-text">${escapeHtml(message || 'Could not load King Star UI.')}</p>
        <button type="button" class="hs-btn primary hs-panel-retry" data-hs-retry-panel>Retry</button>
      </div>`;
    root.querySelector('[data-hs-retry-panel]')?.addEventListener('click', () => {
      openPanel().catch(() => {});
    });
  }

  function viewLooksEmpty() {
    const root = panelViewRoot();
    if (!root) return true;
    if (!root.children.length) return true;
    // Still on the loading placeholder counts as "needs content" only if stuck — treat as empty for remount restore
    return (
      !!root.querySelector('.hs-panel-loading') &&
      !root.querySelector('.hs-setup, .jr-apply, .hs-auth, .hs-profile, .jr-home')
    );
  }

  async function refreshSession() {
    try {
      const res = await withTimeout(send('AUTH_ME'), 4500, null);
      if (res?.ok && res.data) {
        session = {
          user: res.data.user || null,
          profileComplete: !!res.data.profileComplete,
          completedSteps: res.data.completedSteps || {},
        };
      } else if (!res) {
        // Timed out — keep prior session if any; otherwise treat as logged out
        if (!session?.user) {
          session = { user: null, profileComplete: false, completedSteps: {} };
        }
      }
    } catch {
      session = { user: null, profileComplete: false, completedSteps: {} };
    }
    return session;
  }

  async function waitForSetup(maxMs = 2500) {
    const start = Date.now();
    while (!HS.Setup && Date.now() - start < maxMs) {
      await sleepMs(40);
    }
    return !!HS.Setup;
  }

  async function loadProfileDraft() {
    try {
      const res = await send('GET_PROFILE');
      if (res?.ok && res.data?.profile) {
        profileDraft = {
          ...HS.Setup.emptyProfile(),
          ...res.data.profile,
          personal: { ...HS.Setup.emptyProfile().personal, ...(res.data.profile.personal || {}) },
          equalEmployment: {
            ...HS.Setup.emptyProfile().equalEmployment,
            ...(res.data.profile.equalEmployment || {}),
          },
          education:
            res.data.profile.education?.length > 0
              ? res.data.profile.education
              : HS.Setup.emptyProfile().education,
          completedSteps: {
            ...HS.Setup.emptyProfile().completedSteps,
            ...(res.data.profile.completedSteps || {}),
          },
        };
      }
    } catch {
      profileDraft = HS.Setup.emptyProfile();
    }
    return profileDraft;
  }

  function decideInitialView() {
    if (!session.user) return 'setup';
    if (!session.profileComplete) return 'setup';
    return 'apply';
  }

  async function renderView(nextView, opts = {}) {
    ensurePanel();
    mountUiRoot(panel);
    view = nextView;
    if (opts.authMode) authMode = opts.authMode;
    if (opts.profileStep) profileStep = opts.profileStep;

    const root = panelViewRoot();
    if (!root) return;

    if (!HS.Setup) {
      showPanelPlaceholder('Starting King Star…');
      await waitForSetup();
    }
    if (!HS.Setup) {
      showPanelFallback('King Star UI failed to load. Click Retry or reload the page.');
      return;
    }

    if (view !== 'apply') {
      const progressRoot = document.getElementById('hs-progress-view');
      if (progressRoot) {
        progressRoot.hidden = true;
        progressRoot.classList.remove('is-expanded', 'is-collapsed', 'is-busy');
      }
      progressExpanded = false;
      progressBusy = false;
      syncProgressPanelClass();
    }

    if (view === 'setup') {
      root.innerHTML = HS.Setup.renderSetupHome(session);
    } else if (view === 'auth') {
      root.innerHTML = HS.Setup.renderAuth({ mode: authMode });
    } else if (view === 'profile') {
      await loadProfileDraft();
      const p = profileDraft;
      if (profileStep === 'education') root.innerHTML = HS.Setup.renderEducation(p.education);
      else if (profileStep === 'equalEmployment') {
        root.innerHTML = HS.Setup.renderEqualEmployment(p.equalEmployment);
      } else root.innerHTML = HS.Setup.renderPersonal(p.personal);
    } else if (view === 'apply') {
      root.innerHTML = applyHtml();
      wireApplyHandlers();
      await loadSavedResume();
      const hadDraft = await loadDraft();
      syncJobCard();
      syncResumeUI();
      if (progressItemsCache.length) {
        renderAutofillProgress(progressItemsCache, { busy: false, expanded: false });
      }
      if (!hadDraft) {
        setStatus('Tap “Add a new job for this page” to extract details.', false, 'ok');
      }
      // Remember edits on inputs/selectors even before Autofill runs
      startAnswerLearningWatch();
    } else {
      // boot / unknown — never leave the body blank
      root.innerHTML = HS.Setup.renderSetupHome(session);
      view = 'setup';
    }

    wireViewActions(root);
  }

  function wireViewActions(root) {
    root.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const action = btn.getAttribute('data-action');
        if (action === 'open-auth') return renderView('auth', { authMode: 'signin' });
        if (action === 'auth-signin') return renderView('auth', { authMode: 'signin' });
        if (action === 'auth-signup') return renderView('auth', { authMode: 'signin' });
        if (action === 'back-setup') return renderView('setup');
        if (action === 'open-profile' || action === 'edit-profile') {
          setStatus('Opening King Star profile in a new tab…', false, 'busy');
          try {
            const res = await send('OPEN_WEB_PROFILE');
            if (!res?.ok) throw new Error(res?.error || 'Could not open profile');
            setStatus('Complete your profile in the web app, then return here.', false, 'ok');
          } catch (err) {
            setStatus(err.message || 'Could not open web profile', true);
          }
          return;
        }
        if (action === 'start-applying') {
          if (!session.user || !session.profileComplete) {
            setStatus('Finish account + profile setup first.', true);
            return;
          }
          return renderView('apply');
        }
        if (action === 'open-info-dialog') {
          return openInfoDialog();
        }
        if (action === 'close-info-dialog') {
          return closeInfoDialog();
        }
        if (action === 'signout') {
          await send('AUTH_SIGNOUT');
          session = { user: null, profileComplete: false, completedSteps: {} };
          setStatus('Signed out.', false, 'ok');
          return renderView('setup');
        }
        if (action === 'wizard-back') {
          return renderView('profile', { profileStep: btn.getAttribute('data-to') || 'personal' });
        }
      });
    });

    root.querySelectorAll('[data-auth-form]').forEach((form) => {
      form.addEventListener('submit', onAuthSubmit);
    });

    root.querySelectorAll('[data-profile-form]').forEach((form) => {
      form.addEventListener('submit', onProfileSubmit);
    });

    root.querySelectorAll('.hs-flag').forEach((lab) => {
      lab.addEventListener('click', (e) => {
        e.preventDefault();
        const input = lab.querySelector('input');
        if (!input) return;
        input.checked = !input.checked;
        lab.classList.toggle('is-on', input.checked);
      });
    });

    root.querySelectorAll('.hs-toggle').forEach((lab) => {
      lab.addEventListener('click', () => {
        root.querySelectorAll('.hs-toggle').forEach((x) => x.classList.remove('is-on'));
        lab.classList.add('is-on');
      });
    });

    const currentBox = root.querySelector('[name="currentlyStudying"]');
    if (currentBox) {
      currentBox.addEventListener('change', () => {
        const end = root.querySelector('[name="endDate"]');
        if (end) end.disabled = currentBox.checked;
      });
    }
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const data = HS.Setup.formToObject(form);
    setStatus('Signing in…', false, 'busy');
    try {
      const res = await send('AUTH_SIGNIN', data);
      if (!res?.ok) throw new Error(res?.error || 'Auth failed');
      await refreshSession();
      setStatus('Signed in.', false, 'ok');
      await renderView('setup');
    } catch (err) {
      setStatus(err.message || 'Auth failed', true);
    }
  }

  async function onProfileSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const step = form.getAttribute('data-profile-form');
    const data = HS.Setup.formToObject(form);
    setStatus('Saving…', false, 'busy');

    try {
      if (step === 'personal') {
        profileDraft.personal = { ...profileDraft.personal, ...data };
        profileDraft.completedSteps.personal = true;
        await send('SAVE_PROFILE', {
          personal: profileDraft.personal,
          completedSteps: profileDraft.completedSteps,
        });
        setStatus('Personal info saved.', false, 'ok');
        return renderView('profile', { profileStep: 'education' });
      }

      if (step === 'education') {
        profileDraft.education = [
          {
            schoolName: data.schoolName || '',
            major: data.major || '',
            degreeType: data.degreeType || '',
            gpa: data.gpa || '',
            startDate: data.startDate || '',
            endDate: data.currentlyStudying ? '' : data.endDate || '',
            currentlyStudying: !!data.currentlyStudying,
          },
        ];
        profileDraft.completedSteps.education = true;
        await send('SAVE_PROFILE', {
          education: profileDraft.education,
          completedSteps: profileDraft.completedSteps,
        });
        setStatus('Education saved.', false, 'ok');
        return renderView('profile', { profileStep: 'equalEmployment' });
      }

      if (step === 'equalEmployment') {
        profileDraft.equalEmployment = {
          ...profileDraft.equalEmployment,
          workCountries: data.workCountries || [],
          usCitizen: data.usCitizen || '',
          disability: data.disability || '',
          veteran: data.veteran || '',
          gender: data.gender || '',
          lgbtq: data.lgbtq || '',
          race: data.race || '',
          hispanicLatino: data.hispanicLatino || '',
          sexualOrientation: data.sexualOrientation || '',
          pronouns: data.pronouns || '',
        };
        profileDraft.completedSteps.equalEmployment = true;
        const res = await send('COMPLETE_PROFILE', {
          equalEmployment: profileDraft.equalEmployment,
          education: profileDraft.education,
          personal: profileDraft.personal,
          completedSteps: profileDraft.completedSteps,
        });
        if (!res?.ok) throw new Error(res?.error || 'Could not finish profile');
        await refreshSession();
        const synced = res.data?.sync?.pairs || 0;
        setStatus(
          synced
            ? `Profile complete · ${synced} autofill fields ready. You can start applying.`
            : 'Profile complete. You can start applying.',
          false,
          'ok'
        );
        return renderView('setup');
      }
    } catch (err) {
      setStatus(err.message || 'Could not save profile', true);
    }
  }

  function syncJobCard() {
    const card = document.getElementById('hs-job-card');
    const companyEl = document.getElementById('hs-job-company');
    const roleEl = document.getElementById('hs-job-role');
    const company = jobInfo?.companyName || document.getElementById('hs-company')?.value || '';
    const role = jobInfo?.roleName || document.getElementById('hs-role')?.value || '';
    const desc =
      jobInfo?.jobDescription || document.getElementById('hs-desc')?.value || '';
    const hasJob = !!(company || role);
    const canCopy = !!(role || desc);
    if (companyEl) companyEl.textContent = company;
    if (roleEl) roleEl.textContent = role;
    if (card) card.hidden = !hasJob;
    const copyBtn = document.getElementById('hs-copy-job');
    if (copyBtn) {
      copyBtn.disabled = !canCopy;
      copyBtn.title = canCopy
        ? 'Copy job title and description'
        : 'Add a job first to copy title & description';
    }
    updateExtractMeta(jobInfo || {});
  }

  async function refreshOpenAIStatus() {
    const row = document.getElementById('hs-openai-status-row');
    const el = document.getElementById('hs-openai-status');
    const hint = document.getElementById('hs-openai-key-hint');
    if (!el) return null;
    el.textContent = 'OpenAI: checking…';
    row?.classList.remove('is-ready', 'is-missing');
    try {
      const res = await send('OPENAI_STATUS');
      const data = res?.data || {};
      if (data.configured) {
        const via = data.source === 'extension' ? 'extension key' : 'server key';
        el.textContent = `OpenAI ready · ${via}`;
        row?.classList.add('is-ready');
        if (hint) hint.hidden = true;
      } else {
        el.textContent = 'OpenAI key missing — essays won’t fill';
        row?.classList.add('is-missing');
        if (hint) hint.hidden = false;
      }
      return data;
    } catch {
      el.textContent = 'OpenAI status unavailable';
      row?.classList.add('is-missing');
      if (hint) hint.hidden = false;
      return null;
    }
  }

  function wireApplyHandlers() {
    panel.querySelector('#hs-add-job')?.addEventListener('click', () => startAddNewJob({ forceLlm: false }));
    panel.querySelector('#hs-extract')?.addEventListener('click', () => startAddNewJob({ forceLlm: false }));
    panel.querySelector('#hs-extract-ai')?.addEventListener('click', () => startAddNewJob({ forceLlm: true }));
    panel.querySelector('#hs-reset')?.addEventListener('click', () => resetDraft());
    panel.querySelector('#hs-edit-job')?.addEventListener('click', () => openJobDialog(jobInfo || readFormJobInfo()));
    panel.querySelector('#hs-copy-job')?.addEventListener('click', () => copyJobTitleAndDescription());
    panel.querySelector('#hs-autofill')?.addEventListener('click', () => runAutofill());
    panel.querySelector('#hs-save')?.addEventListener('click', () => saveAppliedJob({ auto: false }));
    panel.querySelector('#hs-resume')?.addEventListener('click', () => runResumeUpload());
    panel.querySelector('#hs-resume-preview')?.addEventListener('click', (e) => {
      e.preventDefault();
      openResumePreview();
    });
    panel.querySelector('#hs-openai-key-hint')?.addEventListener('click', (e) => {
      e.preventDefault();
      setStatus('Open the King Star extension popup to paste your OpenAI API key, then Save.', false);
      refreshOpenAIStatus();
    });

    panel.querySelectorAll('[data-action="open-info-dialog"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openInfoDialog();
      });
    });

    refreshOpenAIStatus();
    ensureApplicationSubmitWatch();
  }

  async function openInfoDialog() {
    ensurePanel();
    ensureInfoDialog();
    closeJobDialog();
    await loadProfileDraft();
    infoTab = 'personal';
    renderInfoTab();
    infoDialog.hidden = false;
    document.documentElement.classList.add('hs-dialog-open');
    const updateBtn = document.getElementById('hs-info-update');
    if (updateBtn && !updateBtn.dataset.bound) {
      updateBtn.dataset.bound = '1';
      updateBtn.addEventListener('click', onInfoUpdate);
    }
    infoDialog.querySelectorAll('[data-info-tab]').forEach((btn) => {
      btn.onclick = () => {
        infoTab = btn.getAttribute('data-info-tab') || 'personal';
        renderInfoTab();
      };
    });
  }

  function closeInfoDialog() {
    if (infoDialog) infoDialog.hidden = true;
    if (!jobDialog || jobDialog.hidden) {
      document.documentElement.classList.remove('hs-dialog-open');
    }
  }

  function ensureJobDialog() {
    if (jobDialog && document.contains(jobDialog)) return jobDialog;
    jobDialog = document.createElement('div');
    jobDialog.id = 'hs-job-dialog';
    jobDialog.className = 'jr-dialog jr-job-dialog';
    jobDialog.hidden = true;
    jobDialog.innerHTML = `
      <button type="button" class="jr-dialog-backdrop" data-action="close-job-dialog" aria-label="Close dialog"></button>
      <div class="jr-dialog-panel jr-job-dialog-panel" role="dialog" aria-modal="true" aria-labelledby="hs-job-dialog-title">
        <header class="jr-job-dialog-head">
          <button type="button" class="jr-job-dialog-x" data-action="close-job-dialog" aria-label="Close">×</button>
          <h2 id="hs-job-dialog-title">Add a New Job for This Page</h2>
        </header>
        <div class="jr-job-dialog-body">
          <label class="jr-job-field">
            <span class="jr-job-field-label"><em>*</em> Job Title</span>
            <input id="hs-job-title-input" type="text" autocomplete="off" />
          </label>
          <label class="jr-job-field">
            <span class="jr-job-field-label"><em>*</em> URL for Original Posting</span>
            <input id="hs-job-url-input" type="url" autocomplete="off" />
          </label>
          <label class="jr-job-field">
            <span class="jr-job-field-label"><em>*</em> Company Name</span>
            <div class="jr-job-company-input">
              <span class="jr-job-company-mark" aria-hidden="true">◆</span>
              <input id="hs-job-company-input" type="text" autocomplete="organization" />
            </div>
          </label>
          <label class="jr-job-field jr-job-field-desc">
            <span class="jr-job-field-label"><em>*</em> Job Description</span>
            <textarea id="hs-job-desc-input" rows="12"></textarea>
          </label>
        </div>
        <footer class="jr-job-dialog-foot">
          <button type="button" class="jr-job-dialog-save" id="hs-job-dialog-save">Save</button>
        </footer>
      </div>`;
    document.documentElement.appendChild(jobDialog);

    jobDialog.querySelectorAll('[data-action="close-job-dialog"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        closeJobDialog();
      });
    });
    const saveBtn = jobDialog.querySelector('#hs-job-dialog-save');
    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = '1';
      saveBtn.addEventListener('click', onJobDialogSave);
    }
    return jobDialog;
  }

  function fillJobDialog(info) {
    ensureJobDialog();
    const title = document.getElementById('hs-job-title-input');
    const url = document.getElementById('hs-job-url-input');
    const company = document.getElementById('hs-job-company-input');
    const desc = document.getElementById('hs-job-desc-input');
    if (title) title.value = info?.roleName || '';
    if (url) url.value = info?.sourceUrl || location.href;
    if (company) company.value = info?.companyName || '';
    if (desc) desc.value = info?.jobDescription || '';
  }

  function openJobDialog(info) {
    ensurePanel();
    ensureJobDialog();
    fillJobDialog(info || jobInfo || readFormJobInfo());
    closeInfoDialog();
    jobDialog.hidden = false;
    document.documentElement.classList.add('hs-dialog-open');
  }

  async function copyJobTitleAndDescription() {
    const info = {
      ...(jobInfo || {}),
      ...readFormJobInfo(),
    };
    const title = String(info.roleName || '').trim();
    const company = String(info.companyName || '').trim();
    const description = String(info.jobDescription || '').trim();

    if (!title && !description) {
      setStatus('Add a job for this page first, then copy.', true);
      return;
    }

    const parts = [];
    if (title) parts.push(title);
    if (company) parts.push(`Company: ${company}`);
    if (description) {
      parts.push('');
      parts.push(description);
    }
    const text = parts.join('\n').trim();

    const btn = document.getElementById('hs-copy-job');
    const label = btn?.querySelector('.jr-job-copy-label');
    const icon = btn?.querySelector('.jr-job-copy-icon');
    const copySvg = icon?.innerHTML || '';

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      if (btn) btn.classList.add('is-copied');
      if (label) label.textContent = 'Copied';
      if (icon) {
        icon.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      }
      setStatus('Job title & description copied.', false, 'ok');
      setTimeout(() => {
        if (btn) btn.classList.remove('is-copied');
        if (label) label.textContent = 'Copy';
        if (icon && copySvg) icon.innerHTML = copySvg;
      }, 1600);
    } catch (err) {
      setStatus(err.message || 'Could not copy to clipboard', true);
    }
  }

  function closeJobDialog() {
    if (jobDialog) jobDialog.hidden = true;
    if (!infoDialog || infoDialog.hidden) {
      document.documentElement.classList.remove('hs-dialog-open');
    }
  }

  async function onJobDialogSave() {
    const roleName = document.getElementById('hs-job-title-input')?.value?.trim() || '';
    const sourceUrl = document.getElementById('hs-job-url-input')?.value?.trim() || location.href;
    const companyName = document.getElementById('hs-job-company-input')?.value?.trim() || '';
    const jobDescription = cleanDesc(document.getElementById('hs-job-desc-input')?.value || '');

    if (!roleName || !companyName || !sourceUrl || !jobDescription) {
      setStatus('Please fill all required job fields before saving.', true);
      return;
    }

    const payload = {
      ...(jobInfo || {}),
      roleName,
      companyName,
      sourceUrl,
      jobDescription,
      resumeDriveLink: lastResumeLink,
      resumeDriveFileId: lastResumeFileId,
      steps: { ...steps, extract: true },
    };
    applyJobInfo(payload);
    await persistDraft({ steps: { ...steps, extract: true } });
    closeJobDialog();
    syncJobCard();
    setStatus('Job details saved. You can Autofill when ready.', false, 'ok');
  }

  function fieldMark(done) {
    return `<span class="jr-field-mark ${done ? 'is-done' : ''}" aria-hidden="true">${done ? '✓' : ''}</span>`;
  }

  function infoField(done, label, inputHtml) {
    return `<label class="jr-info-field"><span class="jr-info-field-label">${fieldMark(done)}<span class="jr-info-field-text">${label}</span></span>${inputHtml}</label>`;
  }

  function renderInfoTab() {
    const nav = document.querySelectorAll('#hs-info-dialog [data-info-tab]');
    nav.forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-info-tab') === infoTab);
    });
    renderInfoTop();
    const content = document.getElementById('hs-info-content');
    if (!content || !profileDraft) return;
    const p = profileDraft.personal || {};
    const edu = profileDraft.education?.[0] || {};
    const ee = profileDraft.equalEmployment || {};

    if (infoTab === 'education') {
      content.innerHTML = `
        <div class="jr-info-form">
          <div class="jr-info-section">
            <h3 class="jr-info-section-title">Required</h3>
            ${infoField(filled(edu.schoolName), 'School Name', `<input name="schoolName" value="${escapeHtml(edu.schoolName || '')}" />`)}
          </div>
          <div class="jr-info-section">
            <h3 class="jr-info-section-title">Optional</h3>
            ${infoField(filled(edu.major), 'Major', `<input name="major" value="${escapeHtml(edu.major || '')}" />`)}
            ${infoField(filled(edu.degreeType), 'Degree Type', `<input name="degreeType" value="${escapeHtml(edu.degreeType || '')}" />`)}
            ${infoField(filled(edu.gpa), 'GPA', `<input name="gpa" value="${escapeHtml(edu.gpa || '')}" />`)}
          </div>
        </div>`;
      return;
    }
    if (infoTab === 'equalEmployment') {
      content.innerHTML = `
        <div class="jr-info-form">
          <div class="jr-info-section">
            <h3 class="jr-info-section-title">Optional</h3>
            ${infoField(filled(ee.gender), 'Gender', `<input name="gender" value="${escapeHtml(ee.gender || '')}" />`)}
            ${infoField(filled(ee.race), 'Race', `<input name="race" value="${escapeHtml(ee.race || '')}" />`)}
            ${infoField(filled(ee.disability), 'Disability', `<input name="disability" value="${escapeHtml(ee.disability || '')}" />`)}
            ${infoField(filled(ee.veteran), 'Veteran', `<input name="veteran" value="${escapeHtml(ee.veteran || '')}" />`)}
            ${infoField(filled(ee.pronouns), 'Pronouns', `<input name="pronouns" value="${escapeHtml(ee.pronouns || '')}" />`)}
            ${infoField(filled(ee.lgbtq), 'LGBTQ+', `<input name="lgbtq" value="${escapeHtml(ee.lgbtq || '')}" />`)}
            ${infoField(filled(ee.hispanicLatino), 'Hispanic or Latino', `<input name="hispanicLatino" value="${escapeHtml(ee.hispanicLatino || '')}" />`)}
            ${infoField(filled(ee.sexualOrientation), 'Sexual Orientation', `<input name="sexualOrientation" value="${escapeHtml(ee.sexualOrientation || '')}" />`)}
          </div>
        </div>`;
      return;
    }
    content.innerHTML = `
      <div class="jr-info-form">
        <div class="jr-info-section">
          <h3 class="jr-info-section-title">Required</h3>
          <div class="jr-info-row3">
            ${infoField(filled(p.firstName), 'First Name', `<input name="firstName" value="${escapeHtml(p.firstName || '')}" />`)}
            ${infoField(filled(p.middleName), 'Middle Name', `<input name="middleName" value="${escapeHtml(p.middleName || '')}" />`)}
            ${infoField(filled(p.lastName), 'Last Name', `<input name="lastName" value="${escapeHtml(p.lastName || '')}" />`)}
          </div>
          ${infoField(filled(p.email), 'Email Address', `<input name="email" type="email" value="${escapeHtml(p.email || '')}" />`)}
          <div class="jr-info-row2">
            ${infoField(filled(p.phoneType), 'Phone Type', `<input name="phoneType" value="${escapeHtml(p.phoneType || '')}" />`)}
            ${infoField(filled(p.phone), 'Phone', `<input name="phone" value="${escapeHtml(p.phone || '')}" />`)}
          </div>
          ${infoField(filled(p.addressLine), 'Address Line', `<input name="addressLine" value="${escapeHtml(p.addressLine || '')}" />`)}
          <div class="jr-info-row3">
            ${infoField(filled(p.country), 'Country', `<input name="country" value="${escapeHtml(p.country || '')}" />`)}
            ${infoField(filled(p.state), 'State', `<input name="state" value="${escapeHtml(p.state || '')}" />`)}
            ${infoField(filled(p.city), 'City', `<input name="city" value="${escapeHtml(p.city || '')}" />`)}
          </div>
          <div class="jr-info-row2">
            ${infoField(filled(p.county), 'County', `<input name="county" value="${escapeHtml(p.county || '')}" />`)}
            ${infoField(filled(p.postalCode), 'Postal Code', `<input name="postalCode" value="${escapeHtml(p.postalCode || '')}" />`)}
          </div>
        </div>
        <div class="jr-info-section">
          <h3 class="jr-info-section-title">Optional</h3>
          ${infoField(filled(p.linkedinUrl), 'LinkedIn URL', `<input name="linkedinUrl" value="${escapeHtml(p.linkedinUrl || '')}" />`)}
          ${infoField(filled(p.githubUrl), 'GitHub URL', `<input name="githubUrl" value="${escapeHtml(p.githubUrl || '')}" />`)}
          ${infoField(filled(p.portfolioUrl), 'Portfolio URL', `<input name="portfolioUrl" value="${escapeHtml(p.portfolioUrl || '')}" />`)}
        </div>
      </div>`;
  }

  async function onInfoUpdate() {
    const content = document.getElementById('hs-info-content');
    if (!content || !profileDraft) return;
    const inputs = content.querySelectorAll('input[name]');
    const data = {};
    inputs.forEach((el) => {
      data[el.name] = el.value;
    });
    setStatus('Updating autofill information…', false, 'busy');
    try {
      if (infoTab === 'education') {
        profileDraft.education = [{ ...(profileDraft.education?.[0] || {}), ...data }];
        await send('SAVE_PROFILE', {
          education: profileDraft.education,
          completedSteps: { ...profileDraft.completedSteps, education: true },
        });
      } else if (infoTab === 'equalEmployment') {
        profileDraft.equalEmployment = { ...profileDraft.equalEmployment, ...data };
        await send('SAVE_PROFILE', {
          equalEmployment: profileDraft.equalEmployment,
          completedSteps: { ...profileDraft.completedSteps, equalEmployment: true },
        });
      } else {
        profileDraft.personal = { ...profileDraft.personal, ...data };
        await send('SAVE_PROFILE', {
          personal: profileDraft.personal,
          completedSteps: { ...profileDraft.completedSteps, personal: true },
        });
      }
      setStatus('Autofill information updated.', false, 'ok');
      closeInfoDialog();
    } catch (err) {
      setStatus(err.message || 'Could not update profile', true);
    }
  }

  /* ---------- Apply workflow (existing) ---------- */

  function syncDescViewFromRaw() {
    const raw = document.getElementById('hs-desc')?.value || '';
    const viewEl = document.getElementById('hs-desc-view');
    if (!viewEl) return;
    viewEl.innerHTML = HS.renderJobDescriptionHtml
      ? HS.renderJobDescriptionHtml(raw)
      : `<p class="hs-jd-p">${escapeHtml(raw)}</p>`;
  }

  function setDescription(text) {
    const structured = HS.structureJobDescription
      ? HS.structureJobDescription(text || '')
      : cleanDesc(text || '');
    const ta = document.getElementById('hs-desc');
    if (ta) ta.value = structured;
    syncDescViewFromRaw();
  }

  function toggleDescEdit() {
    const ta = document.getElementById('hs-desc');
    const viewEl = document.getElementById('hs-desc-view');
    const btn = document.getElementById('hs-desc-toggle');
    if (!ta || !viewEl || !btn) return;
    const editing = !ta.hidden;
    if (editing) {
      setDescription(ta.value);
      ta.hidden = true;
      viewEl.hidden = false;
      btn.textContent = 'Edit raw';
      scheduleDraftSave();
    } else {
      ta.hidden = false;
      viewEl.hidden = true;
      btn.textContent = 'Done editing';
      ta.focus();
    }
  }

  function cleanDesc(text) {
    if (HS.structureJobDescription) return HS.structureJobDescription(text);
    if (HS.cleanJobDescription) return HS.cleanJobDescription(text);
    return String(text || '').trim();
  }

  function readFormJobInfo() {
    const urlEl = document.getElementById('hs-url');
    return {
      companyName: document.getElementById('hs-company')?.value?.trim() || '',
      roleName: document.getElementById('hs-role')?.value?.trim() || '',
      jobDescription: cleanDesc(document.getElementById('hs-desc')?.value || ''),
      sourceUrl: urlEl?.value?.trim() || jobInfo?.sourceUrl || location.href,
    };
  }

  function buildDraftPayload(extra = {}) {
    const form = readFormJobInfo();
    return {
      companyName: form.companyName,
      roleName: form.roleName,
      jobDescription: form.jobDescription,
      sourceUrl: form.sourceUrl,
      source: jobInfo?.source || extra.source || null,
      confidence: jobInfo?.confidence ?? extra.confidence ?? null,
      ats: jobInfo?.ats || extra.ats || null,
      cached: jobInfo?.cached || false,
      location: jobInfo?.location || null,
      resumeDriveLink: lastResumeLink,
      resumeDriveFileId: lastResumeFileId,
      steps: { ...steps },
      ...extra,
    };
  }

  async function persistDraft(extra = {}) {
    const draft = buildDraftPayload(extra);
    jobInfo = { ...jobInfo, ...draft };
    await send('SAVE_DRAFT_JOB', draft);
    return draft;
  }

  function scheduleDraftSave() {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => {
      const form = readFormJobInfo();
      steps.extract = !!(form.companyName && form.roleName && form.jobDescription);
      updateSteps();
      persistDraft().catch(() => {});
    }, 400);
  }

  function applyJobInfo(info, { persist = false } = {}) {
    jobInfo = info || {};
    if (view !== 'apply') return;
    ensurePanel();
    const company = document.getElementById('hs-company');
    const role = document.getElementById('hs-role');
    const url = document.getElementById('hs-url');
    if (!company || !role) return;

    company.value = info?.companyName || '';
    role.value = info?.roleName || '';
    if (url) url.value = info?.sourceUrl || location.href;
    setDescription(info?.jobDescription || '');

    lastResumeLink = info?.resumeDriveLink || lastResumeLink || null;
    lastResumeFileId = info?.resumeDriveFileId || lastResumeFileId || null;
    if (info?.resumeFileName) lastResumeName = info.resumeFileName;
    syncResumeUI();

    if (info?.steps) {
      Object.assign(steps, {
        extract: false,
        autofill: false,
        resume: false,
        save: false,
        ...info.steps,
      });
    } else {
      steps.extract = !!(info?.companyName && info?.roleName && info?.jobDescription);
    }
    updateSteps();
    syncJobCard();
    if (persist) persistDraft();
  }

  /** Drop in-memory + local resume after a successful applied-job save (like clearing description). */
  async function clearResumeState() {
    lastResumeLink = null;
    lastResumeFileId = null;
    lastResumeName = null;
    lastResumeMime = null;
    lastResumeDataUrl = null;
    lastResumeText = null;
    try {
      await send('CLEAR_RESUME_LOCAL');
    } catch {
      /* ignore */
    }
    syncResumeUI();
  }

  function clearFormUI() {
    jobInfo = null;
    Object.assign(steps, {
      extract: false,
      autofill: false,
      resume: !!(lastResumeDataUrl || lastResumeLink),
      save: false,
    });
    const company = document.getElementById('hs-company');
    if (company) company.value = '';
    const role = document.getElementById('hs-role');
    if (role) role.value = '';
    const url = document.getElementById('hs-url');
    if (url) url.value = '';
    setDescription('');
    const descInput = document.getElementById('hs-job-desc-input');
    if (descInput) descInput.value = '';
    const saveBtn = document.getElementById('hs-save');
    if (saveBtn) {
      saveBtn.textContent = 'Save applied job';
      saveBtn.disabled = false;
    }
    syncResumeUI();
    syncJobCard();
    updateSteps();
  }

  async function resetDraft() {
    clearTimeout(draftSaveTimer);
    await send('CLEAR_DRAFT_JOB');
    clearFormUI();
    setStatus('Draft cleared. Click Extract on a job page when ready.', false, 'ok');
  }

  function updateExtractMeta(info) {
    const el = document.getElementById('hs-extract-meta');
    if (!el) return;
    if (!info?.source && !info?.companyName) {
      el.textContent = '';
      return;
    }
    const source = info.source || 'draft';
    const conf =
      typeof info.confidence === 'number' ? `${Math.round(info.confidence * 100)}%` : null;
    const ats = info.ats && info.ats !== 'generic' ? info.ats : null;
    const parts = [source];
    if (ats) parts.push(ats);
    if (conf) parts.push(conf);
    if (info.cached) parts.push('cached');
    if (info.sourceUrl) {
      try {
        parts.push(new URL(info.sourceUrl).hostname.replace(/^www\./, ''));
      } catch {
        /* ignore */
      }
    }
    el.textContent = parts.join(' · ');
  }

  async function loadDraft() {
    try {
      const res = await send('GET_DRAFT_JOB');
      if (res?.ok && res.data) {
        applyJobInfo(res.data);
        setStatus('Restored saved job draft from another tab.', false, 'ok');
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  function renderFixedList(items) {
    const list = document.getElementById('hs-fixed-list');
    if (!list) return;

    if (!items.length) {
      list.innerHTML =
        '<p class="hs-fixed-empty">No saved answers yet. Complete your profile or mark applied.</p>';
      return;
    }

    // Dedupe display by normalized question (keep newest / first in sorted list)
    const seenQ = new Set();
    const unique = [];
    for (const item of items) {
      const q = String(item.questionPattern || item.question_pattern || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (!q || seenQ.has(q)) continue;
      seenQ.add(q);
      unique.push(item);
    }

    list.innerHTML = unique
      .map(
        (item) => `
      <div class="hs-fixed-item" data-id="${escapeHtml(item.id)}">
        <div class="hs-fixed-item-main">
          <div class="hs-fixed-q">${escapeHtml(item.questionPattern || item.question_pattern || '')}</div>
          <div class="hs-fixed-a">${escapeHtml(item.answer || '')}</div>
        </div>
        <button type="button" class="hs-fixed-del" data-id="${escapeHtml(item.id)}" title="Delete">×</button>
      </div>`
      )
      .join('');

    list.querySelectorAll('.hs-fixed-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const id = btn.getAttribute('data-id');
        if (!id) return;
        btn.disabled = true;
        try {
          const res = await send('DELETE_FIXED_ANSWER', { id });
          if (!res?.ok) throw new Error(res?.error || 'Delete failed');
          await refreshFixedAnswers();
          setStatus('Saved answer removed.', false, 'ok');
        } catch (err) {
          setStatus(err.message || 'Could not delete', true);
          btn.disabled = false;
        }
      });
    });
  }

  async function refreshFixedAnswers() {
    try {
      const res = await send('LIST_FIXED_ANSWERS');
      if (res?.ok && Array.isArray(res.data)) {
        fixedCount = res.data.length;
        const chip = document.getElementById('hs-fixed-count');
        if (chip) chip.textContent = `${fixedCount} saved`;
        renderFixedList(res.data);
      }
    } catch {
      const list = document.getElementById('hs-fixed-list');
      if (list) {
        list.innerHTML =
          '<p class="hs-fixed-empty">Could not load saved answers. Is the API running?</p>';
      }
    }
  }

  async function refreshFixedCount() {
    return refreshFixedAnswers();
  }

  function pairsSignature(pairs) {
    return (pairs || [])
      .map((p) => {
        const q = String(p.question || '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
        const a = String(p.answer || '')
          .replace(/\s+/g, ' ')
          .trim();
        return `${q}|${a}`;
      })
      .sort()
      .join('\n');
  }

  async function rememberFilledAnswers() {
    if (!HS.collectFilledAnswers) return { saved: 0 };
    const pairs = HS.collectFilledAnswers();
    // Answers on embedded (iframe) application forms
    try {
      const res = await send('FRAMES_CALL', { fn: 'frameCollectFilled' });
      if (res?.ok) for (const f of res.data || []) if (Array.isArray(f.result)) pairs.push(...f.result);
    } catch {
      /* ignore */
    }
    if (!pairs.length) return { saved: 0 };
    const res = await send('SAVE_FIXED_ANSWERS_BULK', {
      answers: pairs,
      onlyRepetitive: true,
    });
    if (!res?.ok) throw new Error(res?.error || 'Could not save answers');
    answerLearnSig = pairsSignature(pairs);
    await refreshFixedCount();
    return res.data;
  }

  function stopAnswerLearningWatch() {
    answerLearnEnabled = false;
    if (HS.stopAnswerLearning) HS.stopAnswerLearning();
  }

  function captureProgressBaseline() {
    progressValueBaseline = new Map();
    if (!HS.getQuestionFillState) return;
    try {
      for (const s of HS.getQuestionFillState()) {
        progressValueBaseline.set(s.id, s.value);
        const qk = String(s.question || '')
          .toLowerCase()
          .trim();
        if (qk) progressValueBaseline.set(`q:${qk}`, s.value);
      }
    } catch {
      /* ignore */
    }
  }

  function progressQuestionKey(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function setChoiceOverride(question, answer, ms = 120000) {
    const qk = progressQuestionKey(question);
    if (!qk || !answer) return;
    const entry = { answer: String(answer).trim(), expires: Date.now() + ms, question };
    progressChoiceOverrides.set(qk, entry);
    // Also index by shorter token keys for fuzzy board rows
    const short = qk.split(' ').slice(0, 8).join(' ');
    if (short && short !== qk) progressChoiceOverrides.set(short, entry);
  }

  function getChoiceOverride(question) {
    const qk = progressQuestionKey(question);
    if (!qk) return null;
    const direct = progressChoiceOverrides.get(qk);
    if (direct && Date.now() < direct.expires) return direct;
    for (const [key, entry] of progressChoiceOverrides) {
      if (Date.now() >= entry.expires) {
        progressChoiceOverrides.delete(key);
        continue;
      }
      if (questionsLooselyMatch(question, entry.question) || questionsLooselyMatch(question, key)) {
        return entry;
      }
    }
    return null;
  }

  /** Mark one progress row filled from a just-edited Yes/No (or other) answer. */
  function syncProgressFromPair(pair) {
    if (!pair?.question || pair.answer == null || !String(pair.answer).trim()) return false;
    if (!progressItemsCache.length) return false;
    const qk = progressQuestionKey(pair.question);
    const answer = String(pair.answer).trim();
    // Pin Yes/No so the next DOM poll cannot wipe "updated" → "todo"
    if (/^(yes|no)$/i.test(answer) || pair.type === 'choice-button' || pair.type === 'radio') {
      setChoiceOverride(pair.question, answer);
    }
    let any = false;
    progressItemsCache = progressItemsCache.map((item) => {
      if (item.id === '__resume__' || String(item.id).startsWith('__history_')) return item;
      const match =
        progressQuestionKey(item.question) === qk ||
        (pair.id && item.id === pair.id) ||
        questionsLooselyMatch(item.question, pair.question);
      if (!match) return item;
      any = true;
      progressValueBaseline.set(item.id, answer);
      progressValueBaseline.set(`q:${progressQuestionKey(item.question)}`, answer);
      return { ...item, filled: true, source: 'updated' };
    });
    if (!any) {
      // Add the row if the board was missing it
      progressItemsCache.push({
        id: pair.id || `choice_${qk.slice(0, 24)}`,
        question: pair.question,
        required: true,
        filled: true,
        source: 'updated',
      });
      any = true;
    }
    if (any) {
      progressItemsCache = dedupeProgress(progressItemsCache);
      progressExpanded = true;
      renderAutofillProgress(progressItemsCache, {
        busy: false,
        expanded: true,
      });
    }
    return any;
  }

  function questionsLooselyMatch(a, b) {
    const na = progressQuestionKey(a);
    const nb = progressQuestionKey(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.includes(nb) || nb.includes(na)) return true;
    const ta = new Set(na.split(' ').filter((t) => t.length > 2));
    const tb = new Set(nb.split(' ').filter((t) => t.length > 2));
    if (ta.size < 3 || tb.size < 3) return false;
    let hits = 0;
    for (const t of ta) if (tb.has(t)) hits += 1;
    return hits / Math.max(ta.size, tb.size) >= 0.55;
  }

  /** Live progress board: todo → updated + check when the user fills/edits fields. */
  function syncProgressFromUserEdits(states) {
    if (!progressItemsCache.length) return false;
    let list =
      Array.isArray(states) && states.length
        ? states
        : HS.getQuestionFillState
          ? HS.getQuestionFillState()
          : [];
    if (!list.length) return false;

    // Overlay click-pinned Yes/No so flaky DOM reads cannot flip filled→empty
    list = list.map((s) => {
      const ov = getChoiceOverride(s.question);
      if (!ov) return s;
      return { ...s, filled: true, value: ov.answer };
    });

    const byId = new Map(list.map((s) => [s.id, s]));
    const byQ = new Map(list.map((s) => [progressQuestionKey(s.question), s]));

    let any = false;
    progressItemsCache = progressItemsCache.map((item) => {
      if (item.id === '__resume__' || String(item.id).startsWith('__history_')) return item;
      const qk = progressQuestionKey(item.question);
      const ov = getChoiceOverride(item.question);
      let st = byId.get(item.id) || byQ.get(qk);
      if (!st) {
        // Fuzzy match for long Ashby question labels
        for (const s of list) {
          if (questionsLooselyMatch(item.question, s.question)) {
            st = s;
            break;
          }
        }
      }
      // Board row with a click override but missing from DOM scan — still keep filled
      if (!st && ov) {
        any = true;
        return { ...item, filled: true, source: 'updated' };
      }
      if (!st) return item;

      if (ov) {
        st = { ...st, filled: true, value: ov.answer };
      }

      const baseline =
        progressValueBaseline.get(item.id) ?? progressValueBaseline.get(`q:${qk}`);
      const nowFilled = !!st.filled;
      const valueChanged =
        baseline !== undefined && String(baseline) !== String(st.value || '');

      if (nowFilled) {
        const becameFilled = !item.filled;
        const wasTodo =
          !item.source ||
          item.source === 'unmatched' ||
          item.source === 'needs_user' ||
          item.source === 'error';
        if (becameFilled || wasTodo || valueChanged) {
          any = true;
          progressValueBaseline.set(item.id, String(st.value || ''));
          progressValueBaseline.set(`q:${qk}`, String(st.value || ''));
          // User click → always "updated"; keep profile/saved only if value unchanged
          if (valueChanged || becameFilled || wasTodo) {
            return { ...item, filled: true, source: 'updated' };
          }
          const keepSource =
            item.source &&
            item.source !== 'unmatched' &&
            item.source !== 'needs_user' &&
            item.source !== 'error'
              ? item.source
              : 'updated';
          return { ...item, filled: true, source: keepSource };
        }
        return item;
      }

      // Cleared by user → back to todo / unchecked
      // Never undo a pinned Yes/No click (DOM often still reports empty for Ashby)
      if (ov && /^(yes|no)$/i.test(ov.answer)) {
        if (!item.filled || item.source === 'unmatched') {
          any = true;
          return { ...item, filled: true, source: 'updated' };
        }
        return item;
      }
      if (item.filled || (item.source && item.source !== 'unmatched')) {
        any = true;
        return { ...item, filled: false, source: 'unmatched' };
      }
      return item;
    });

    // New filled fields not yet on the board
    for (const st of list) {
      if (!st.filled) continue;
      const qk = progressQuestionKey(st.question);
      const exists = progressItemsCache.some(
        (i) =>
          i.id === st.id ||
          progressQuestionKey(i.question) === qk ||
          questionsLooselyMatch(i.question, st.question)
      );
      if (exists) continue;
      any = true;
      progressItemsCache.push({
        id: st.id,
        question: st.question,
        required: true,
        filled: true,
        source: 'updated',
      });
    }

    if (any) {
      progressItemsCache = dedupeProgress(progressItemsCache);
      progressExpanded = true;
      renderAutofillProgress(progressItemsCache, {
        busy: false,
        expanded: true,
      });
    }
    return any;
  }

  async function saveLearnedPairs(pairs, { quiet = false } = {}) {
    if (!pairs?.length) return { saved: 0 };
    // Dedupe by question so we never post the same Q twice in one batch
    const byQ = new Map();
    for (const p of pairs) {
      if (!p?.question || p.answer == null) continue;
      if (/cover\s*letter/i.test(p.question)) continue;
      const a = String(p.answer).trim();
      if (!a) continue;
      const qk = String(p.question)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (!qk) continue;
      byQ.set(qk, { ...p, answer: a });
    }
    const cleaned = [...byQ.values()];
    if (!cleaned.length) return { saved: 0 };
    const res = await send('SAVE_FIXED_ANSWERS_BULK', {
      answers: cleaned,
      onlyRepetitive: true,
    });
    if (!res?.ok) throw new Error(res?.error || 'Could not save answers');
    const saved = res.data?.saved || 0;
    const unchanged = res.data?.unchanged || 0;
    if (saved > 0) {
      answerLearnSig = pairsSignature(cleaned);
      await refreshFixedCount();
      if (!quiet) {
        setStatus(
          `Remembered ${saved} answer(s) — will reuse on the next application`,
          false,
          'ok'
        );
      }
    } else if (unchanged > 0) {
      answerLearnSig = pairsSignature(cleaned);
    }
    return { saved, unchanged, ...(res.data || {}) };
  }

  /** Watch page edits (inputs + selectors) and remember Q→A for the next application. */
  function startAnswerLearningWatch() {
    if (!HS.startAnswerLearning) return;
    stopAnswerLearningWatch();
    answerLearnEnabled = true;
    captureProgressBaseline();
    const recentFieldSig = new Set();

    HS.startAnswerLearning(
      async (pairs) => {
        if (!answerLearnEnabled || answerLearnBusy || !pairs?.length) return;
        const sig = pairsSignature(pairs);
        if (sig === answerLearnSig) return;
        answerLearnBusy = true;
        try {
          // Field-level saves already toasted; keep bulk quiet
          await saveLearnedPairs(pairs, { quiet: true });
        } catch {
          /* non-fatal */
        } finally {
          answerLearnBusy = false;
        }
      },
      {
        debounceMs: 900,
        immediateMs: 160,
        onImmediate: (states) => {
          if (!answerLearnEnabled || progressBusy) return;
          syncProgressFromUserEdits(states);
        },
        // Save each edited field with its question as soon as it settles
        onFieldChange: async (pair) => {
          if (!answerLearnEnabled || !pair?.question || !pair?.answer) return;
          // Progress board: Yes/No click → check + "updated" immediately
          try {
            syncProgressFromPair(pair);
          } catch {
            /* ignore */
          }
          const key = `${pair.question.toLowerCase()}|${String(pair.answer).trim()}`;
          if (recentFieldSig.has(key)) return;
          recentFieldSig.add(key);
          if (recentFieldSig.size > 80) recentFieldSig.clear();
          try {
            const { saved } = await saveLearnedPairs([pair], { quiet: true });
            if (saved > 0) {
              setStatus(
                `Saved “${shortQuestionLabel(pair.question)}” → ${String(pair.answer).trim()} for next apps`,
                false,
                'ok'
              );
            }
          } catch {
            /* non-fatal */
          }
        },
      }
    );
  }

  async function runLlmExtract(localHints) {
    const pageText = HS.getPageTextForLlm ? HS.getPageTextForLlm() : document.body.innerText;
    const res = await send('EXTRACT_JOB', {
      pageText,
      pageUrl: location.href,
      title: document.title,
      hints: {
        companyName: localHints?.companyName || '',
        roleName: localHints?.roleName || '',
        ats: localHints?.ats || '',
        source: localHints?.source || '',
      },
    });
    if (!res?.ok) throw new Error(res?.error || 'AI extract failed');
    return {
      companyName: res.data.companyName,
      roleName: res.data.roleName,
      jobDescription: res.data.jobDescription,
      location: res.data.location || null,
      source: res.data.source || 'openai',
      confidence: res.data.confidence,
      cached: !!res.data.cached,
      ats: localHints?.ats || 'generic',
      sourceUrl: location.href,
      extractedAt: new Date().toISOString(),
    };
  }

  function normalizeCompanyKey(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co)\b\.?/gi, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function companiesMatch(a, b) {
    const ka = normalizeCompanyKey(a);
    const kb = normalizeCompanyKey(b);
    if (!ka || !kb) return false;
    if (ka === kb) return true;
    // Soft: one contains the other when both are meaningful length
    if (ka.length >= 3 && kb.length >= 3 && (ka.includes(kb) || kb.includes(ka))) return true;
    return false;
  }

  function formatAppliedAt(iso) {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  async function listAppliedJobsForCompany(companyName) {
    const key = normalizeCompanyKey(companyName);
    if (!key) return [];
    try {
      const res = await send('LIST_APPLIED_JOBS');
      const all = res?.ok && Array.isArray(res.data) ? res.data : [];
      return all.filter((j) => companiesMatch(j.companyName, companyName));
    } catch (err) {
      console.warn('LIST_APPLIED_JOBS failed', err);
      return [];
    }
  }

  /**
   * If this company already has applied jobs, show them and ask to continue.
   * Resolves true to proceed with extract, false to cancel.
   */
  function confirmExistingCompanyJobs(companyName, jobs) {
    return new Promise((resolve) => {
      let dlg = document.getElementById('hs-company-dup-dialog');
      if (dlg) dlg.remove();

      dlg = document.createElement('div');
      dlg.id = 'hs-company-dup-dialog';
      dlg.className = 'jr-dialog jr-company-dup-dialog';
      const rows = (jobs || [])
        .map((j) => {
          const role = escapeHtml(j.roleName || 'Untitled role');
          const when = formatAppliedAt(j.appliedAt);
          const url = j.sourceUrl
            ? `<a href="${escapeHtml(j.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="jr-dup-job-link">Open</a>`
            : '';
          return `<li class="jr-dup-job-row">
            <div class="jr-dup-job-main">
              <strong class="jr-dup-job-role">${role}</strong>
              ${when ? `<span class="jr-dup-job-date">Applied ${escapeHtml(when)}</span>` : ''}
            </div>
            ${url}
          </li>`;
        })
        .join('');

      dlg.innerHTML = `
        <button type="button" class="jr-dialog-backdrop" data-dup-action="cancel" aria-label="Close"></button>
        <div class="jr-dialog-panel jr-company-dup-panel" role="dialog" aria-modal="true" aria-labelledby="hs-company-dup-title">
          <header class="jr-company-dup-head">
            <button type="button" class="jr-job-dialog-x" data-dup-action="cancel" aria-label="Close">×</button>
            <h2 id="hs-company-dup-title">Company already in Applied jobs</h2>
            <p class="jr-company-dup-lead">
              You already saved <strong>${escapeHtml(companyName)}</strong>
              (${jobs.length} job${jobs.length === 1 ? '' : 's'}). Continue adding another role from this page?
            </p>
          </header>
          <div class="jr-company-dup-body">
            <ul class="jr-dup-job-list">${rows}</ul>
          </div>
          <footer class="jr-company-dup-foot">
            <button type="button" class="jr-dup-cancel" data-dup-action="cancel">Cancel</button>
            <button type="button" class="jr-dup-continue" data-dup-action="continue">Continue</button>
          </footer>
        </div>`;
      document.documentElement.appendChild(dlg);
      document.documentElement.classList.add('hs-dialog-open');

      const finish = (ok) => {
        dlg.remove();
        const jobOpen = document.getElementById('hs-job-dialog');
        const infoOpen = document.getElementById('hs-info-dialog');
        if ((!jobOpen || jobOpen.hidden) && (!infoOpen || infoOpen.hidden)) {
          document.documentElement.classList.remove('hs-dialog-open');
        }
        resolve(ok);
      };

      dlg.addEventListener('click', (e) => {
        const action = e.target?.closest?.('[data-dup-action]')?.getAttribute('data-dup-action');
        if (action === 'continue') finish(true);
        else if (action === 'cancel') finish(false);
      });
    });
  }

  /**
   * "Add a new job" entry: detect company on page, warn if already in Applied jobs,
   * then extract when the user continues (or when no duplicates).
   */
  async function startAddNewJob({ forceLlm = false } = {}) {
    if (extractInFlight) return;
    ensurePanel();
    setBusy(['hs-extract', 'hs-extract-ai', 'hs-reset', 'hs-add-job'], true);
    setStatus('Checking company against Applied jobs…', false, 'busy');

    try {
      const local = HS.extractJobInfoLocal ? HS.extractJobInfoLocal() : HS.extractJobInfo();
      const companyName = String(local?.companyName || '').trim();

      if (companyName) {
        const existing = await listAppliedJobsForCompany(companyName);
        if (existing.length) {
          setBusy(['hs-extract', 'hs-extract-ai', 'hs-reset', 'hs-add-job'], false);
          setStatus(
            `Found ${existing.length} saved job(s) at ${companyName}. Confirm to continue…`,
            false,
            'busy'
          );
          const ok = await confirmExistingCompanyJobs(companyName, existing);
          if (!ok) {
            // Stop: leave description blank and do not extract.
            if (jobInfo) {
              jobInfo = { ...jobInfo, jobDescription: '' };
            }
            setDescription('');
            const descInput = document.getElementById('hs-job-desc-input');
            if (descInput) descInput.value = '';
            steps.extract = false;
            updateSteps();
            syncJobCard();
            persistDraft();
            setStatus('Add job stopped — job description left blank.', false, 'ok');
            return;
          }
        }
      }

      await refreshExtract({ forceLlm });
    } catch (err) {
      setStatus(err.message || 'Could not start add job', true);
      setBusy(['hs-extract', 'hs-extract-ai', 'hs-reset', 'hs-add-job'], false);
    }
  }

  async function refreshExtract({ forceLlm = false } = {}) {
    if (extractInFlight) return;
    if (view !== 'apply') await renderView('apply');
    extractInFlight = true;
    ensurePanel();
    setBusy(['hs-extract', 'hs-extract-ai', 'hs-reset', 'hs-add-job'], true);
    setStatus('Extracting from this page…', false, 'busy');

    try {
      const local = HS.extractJobInfoLocal ? HS.extractJobInfoLocal() : HS.extractJobInfo();
      applyJobInfo({
        ...local,
        sourceUrl: location.href,
        resumeDriveLink: lastResumeLink,
        resumeDriveFileId: lastResumeFileId,
      });

      const needsLlm =
        forceLlm ||
        local.needsLlm ||
        (typeof local.confidence === 'number' && local.confidence < (HS.CONFIDENCE_OK || 0.72));

      let finalInfo = {
        ...local,
        sourceUrl: location.href,
        resumeDriveLink: lastResumeLink,
        resumeDriveFileId: lastResumeFileId,
        steps: { ...steps, extract: true },
      };

      if (needsLlm || forceLlm) {
        setStatus(forceLlm ? 'Running AI extraction…' : 'Low confidence — asking OpenAI…', false, 'busy');
        try {
          const ai = await runLlmExtract(local);
          // Low confidence is often just a missing company/role. A solid DOM-extracted description
          // keeps the page's exact wording and layout, so prefer it over the model's copy.
          const keepLocalDesc = !forceLlm && (local.descriptionScore || 0) >= 250;
          // A company confirmed in the visible job header beats the model (which can pick the board's brand)
          const keepLocalCompany = !!local.companyName && (local.companyScore || 0) >= 60;
          // Same for a title confirmed by several page signals (heading + page title + structured data)
          const keepLocalRole = !!local.roleName && (local.roleScore || 0) >= 70;
          finalInfo = {
            ...ai,
            companyName: keepLocalCompany ? local.companyName : ai.companyName || local.companyName,
            roleName: keepLocalRole ? local.roleName : ai.roleName || local.roleName,
            jobDescription: keepLocalDesc ? local.jobDescription : ai.jobDescription || local.jobDescription,
            resumeDriveLink: lastResumeLink,
            resumeDriveFileId: lastResumeFileId,
            steps: { ...steps, extract: true },
          };
          applyJobInfo(finalInfo);
          setStatus(
            ai.cached ? 'AI result from cache. Draft saved.' : 'AI extraction complete. Draft saved.',
            false,
            'ok'
          );
        } catch (err) {
          applyJobInfo(finalInfo);
          setStatus(`Kept local extract — ${err.message || 'AI failed'}. Draft saved.`, true);
        }
      } else {
        applyJobInfo(finalInfo);
        setStatus(`Extracted via ${local.source}. Draft saved across tabs.`, false, 'ok');
      }

      steps.extract = !!(finalInfo.companyName && finalInfo.roleName && finalInfo.jobDescription);
      updateSteps();
      await persistDraft({ steps: { ...steps } });
      openJobDialog(finalInfo);
    } finally {
      extractInFlight = false;
      setBusy(['hs-extract', 'hs-extract-ai', 'hs-reset', 'hs-add-job'], false);
      syncJobCard();
    }
  }

  async function restorePanelContent() {
    if (panelRestoreInFlight) return;
    panelRestoreInFlight = true;
    try {
      showPanelPlaceholder('Restoring King Star…');
      await refreshSession();
      const next = view && view !== 'boot' ? view : decideInitialView();
      await renderView(next);
    } catch (err) {
      console.warn('restorePanelContent failed', err);
      try {
        await renderView(decideInitialView());
      } catch {
        showPanelFallback('Could not restore the panel. Click Retry.');
      }
    } finally {
      panelRestoreInFlight = false;
    }
  }

  async function openPanel() {
    if (openPanelInFlight) return openPanelInFlight;
    openPanelInFlight = (async () => {
      ensurePanel();
      ensureDock();
      mountUiRoot(panel);
      mountUiRoot(dock);
      setPanelOpen(true);
      // Paint loading UI immediately so the body is never blank
      showPanelPlaceholder('Loading King Star…');

      // If the host page wiped our DOM mid-open, remount once more
      if (!isMounted(panel)) {
        panel = null;
        ensurePanel();
        setPanelOpen(true);
        showPanelPlaceholder('Loading King Star…');
      }

      await refreshSession();
      const next = decideInitialView();
      await renderView(next === 'apply' && view === 'apply' ? 'apply' : next);

      // Final guard: still empty → try once more
      if (viewLooksEmpty()) {
        await renderView(decideInitialView());
      }
    })();
    try {
      await openPanelInFlight;
    } finally {
      openPanelInFlight = null;
    }
  }

  /** Recover when Greenhouse/Ashby SPAs remove our panel but leave the empty split gap. */
  function ensureUiAlive() {
    const splitOpen = document.documentElement.classList.contains('hs-split-open');
    const panelOpen = !!(panel && panel.classList.contains('hs-open'));

    if (panelOpen || splitOpen) {
      if (!isMounted(panel) || !isMounted(dock)) {
        const wasOpen = panelOpen || splitOpen;
        if (!isMounted(panel)) panel = null;
        if (!isMounted(dock)) dock = null;
        ensurePanel();
        ensureDock();
        if (wasOpen) {
          setPanelOpen(true);
          restorePanelContent().catch(() => {});
        }
        return;
      }
      mountUiRoot(panel);
      mountUiRoot(dock);
      // Panel open but body blank (e.g. remount without render)
      if (panelOpen && viewLooksEmpty() && !panelRestoreInFlight && !openPanelInFlight) {
        restorePanelContent().catch(() => {});
      }
      return;
    }

    // Panel closed — keep a reachable dock unless the user dismissed it
    if (!isMounted(dock)) {
      dock = null;
      ensureDock();
    } else {
      mountUiRoot(dock);
    }
  }

  // When user returns from the web profile tab, refresh setup status
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!panel?.classList.contains('hs-open')) return;
    if (view !== 'setup') return;
    refreshSession().then(() => renderView('setup')).catch(() => {});
  });

  function dataUrlToFile(dataUrl, fileName, mimeType) {
    const parts = String(dataUrl || '').split(',');
    if (parts.length < 2) throw new Error('Invalid resume data');
    const header = parts[0];
    const b64 = parts[1];
    const mime = mimeType || header.match(/:(.*?);/)?.[1] || 'application/pdf';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], fileName || 'resume.pdf', { type: mime });
  }

  async function loadSavedResume() {
    try {
      const res = await send('GET_RESUME_LOCAL');
      if (!res?.ok || !res.data?.dataUrl) return false;
      lastResumeDataUrl = res.data.dataUrl;
      lastResumeName = res.data.fileName || 'resume.pdf';
      lastResumeMime = res.data.mimeType || 'application/pdf';
      lastResumeText = res.data.resumeText || lastResumeText || '';
      lastResumeLink = res.data.webViewLink || lastResumeLink;
      lastResumeFileId = res.data.fileId || lastResumeFileId;
      steps.resume = true;
      updateSteps();
      syncResumeUI();
      return true;
    } catch {
      return false;
    }
  }

  async function extractResumeText(file) {
    const name = file?.name || '';
    const mime = file?.type || '';
    try {
      if (/\.txt$/i.test(name) || mime.startsWith('text/')) {
        return String(await file.text()).slice(0, 16000);
      }
      if (/\.docx$/i.test(name) || /wordprocessingml/i.test(mime)) {
        await send('ENSURE_MAMMOTH');
        if (typeof mammoth === 'undefined' || !mammoth.extractRawText) {
          return '';
        }
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        return String(result.value || '').slice(0, 16000);
      }
    } catch (err) {
      console.warn('Resume text extract failed', err);
    }
    return '';
  }

  let resumeHistoryCache = null; // { key, data } — one LLM parse per resume

  /**
   * Structured work / education history parsed from the uploaded resume (server-side, so PDFs work).
   * Also back-fills lastResumeText for PDFs, whose text the extension cannot read itself.
   */
  let resumeHistoryInFlight = null;

  function loadResumeHistory() {
    // History filling and AI resume context can ask at the same time: share one request
    if (!resumeHistoryInFlight) {
      resumeHistoryInFlight = loadResumeHistoryOnce().finally(() => {
        resumeHistoryInFlight = null;
      });
    }
    return resumeHistoryInFlight;
  }

  /* ---------- Embedded application forms (iframes) ---------- */

  const frameQid = (frameId, id) => `f${frameId}::${id}`;
  const isFrameQid = (id) => /^f\d+::/.test(String(id || ''));
  const frameOfQid = (id) => Number(String(id).match(/^f(\d+)::/)?.[1]);
  const localQid = (id) => String(id).replace(/^f\d+::/, '');

  /** Sub-frames that contain an application form: [{ frameId, result: { questions, resumeInputs, hasHistory } }]. */
  async function collectFrames() {
    try {
      const res = await send('FRAMES_CALL', { fn: 'frameCollect' });
      return res?.ok && Array.isArray(res.data) ? res.data : [];
    } catch {
      return [];
    }
  }

  function historyProgressRows(entries, frameId) {
    return (entries || []).map((e) => ({
      id: `__history_${frameId ?? 'top'}_${e.section}_${e.index}__`,
      question: `${e.section === 'work' ? 'Work history' : 'Education'} ${e.index + 1}: ${e.label}`,
      required: false,
      filled: e.filled,
      source: e.filled ? 'resume' : 'unmatched',
    }));
  }

  /** Fill every embedded form in parallel; each frame attaches the resume, fills history, then answers. */
  async function fillFrames(frames, answers, history) {
    const out = { filled: 0, resumeFilled: 0, items: [] };
    const resume = lastResumeDataUrl
      ? { dataUrl: lastResumeDataUrl, name: lastResumeName || 'resume.pdf', mime: lastResumeMime || '' }
      : null;
    await Promise.all(
      frames.map(async (f) => {
        const mine = answers
          .filter((a) => frameOfQid(a.id) === f.frameId)
          .map((a) => ({ ...a, id: localQid(a.id) }));
        try {
          const res = await send('FRAMES_CALL', {
            fn: 'frameFill',
            frameIds: [f.frameId],
            arg: {
              answers: mine,
              history: f.result.hasHistory ? history : null,
              resume: f.result.resumeInputs ? resume : null,
            },
          });
          const r = res?.ok ? res.data?.[0]?.result : null;
          if (!r) return;
          out.filled += r.filled || 0;
          out.resumeFilled += r.resumeFilled || 0;
          out.items.push(
            ...(r.items || []).map((i) => ({ ...i, id: frameQid(f.frameId, i.id) })),
            ...historyProgressRows(r.historyEntries, f.frameId)
          );
        } catch (err) {
          console.warn('Frame fill failed', err);
        }
      })
    );
    return out;
  }

  async function loadResumeHistoryOnce() {
    if (!lastResumeDataUrl && !lastResumeText) await loadSavedResume();
    if (!lastResumeDataUrl && !lastResumeText) return null;
    const key = `${lastResumeName || ''}|${(lastResumeDataUrl || '').length}|${(lastResumeText || '').length}`;
    if (resumeHistoryCache?.key === key) return resumeHistoryCache.data;
    const hasText = (lastResumeText || '').trim().length >= 40;
    const res = await send('PARSE_RESUME_HISTORY', {
      resumeText: hasText ? lastResumeText : '',
      resumeDataUrl: hasText ? undefined : lastResumeDataUrl,
      resumeName: lastResumeName || '',
    });
    if (!res?.ok) throw new Error(res?.error || 'Resume analysis failed');
    if (!hasText && res.data?.text) lastResumeText = res.data.text;
    resumeHistoryCache = {
      key: `${lastResumeName || ''}|${(lastResumeDataUrl || '').length}|${(lastResumeText || '').length}`,
      data: res.data,
    };
    return res.data;
  }

  async function buildResumeContext() {
    if (!lastResumeText) await loadSavedResume();
    // PDFs: the extension can't read them — the server extracts the text (cached per resume)
    if (!lastResumeText && lastResumeDataUrl) {
      try {
        await loadResumeHistory();
      } catch {
        /* AI answers fall back to profile-only context */
      }
    }
    const chunks = [];
    if (lastResumeName) chunks.push(`Resume file: ${lastResumeName}`);
    if (lastResumeText) chunks.push(lastResumeText.slice(0, 12000));
    try {
      const res = await send('GET_PROFILE');
      const profile = res?.ok ? res.data?.profile : null;
      if (profile?.personal) {
        const p = profile.personal;
        const bits = [
          p.firstName && p.lastName ? `Name: ${p.firstName} ${p.lastName}` : '',
          p.email ? `Email: ${p.email}` : '',
          p.phone ? `Phone: ${p.phone}` : '',
          p.linkedinUrl ? `LinkedIn: ${p.linkedinUrl}` : '',
          p.githubUrl ? `GitHub: ${p.githubUrl}` : '',
          p.city || p.state || p.country
            ? `Location: ${[p.city, p.state, p.country].filter(Boolean).join(', ')}`
            : '',
        ].filter(Boolean);
        if (bits.length) chunks.push(`Profile:\n${bits.join('\n')}`);
      }
      const edu = profile?.education?.[0];
      if (edu?.schoolName) {
        chunks.push(
          `Education: ${[edu.schoolName, edu.degreeType, edu.major].filter(Boolean).join(' · ')}`
        );
      }
    } catch {
      /* ignore */
    }
    return chunks.join('\n\n').slice(0, 14000);
  }

  function syncResumeUI() {
    const block = document.querySelector('.jr-resume-block');
    const label = document.querySelector('#hs-resume .jr-menu-label');
    const name = document.getElementById('hs-resume-name');
    const previewBtn = document.getElementById('hs-resume-preview');
    const hasResume = !!(lastResumeDataUrl || lastResumeLink);
    if (block) block.classList.toggle('has-resume', hasResume);
    if (label) label.textContent = hasResume ? 'Replace Resume' : 'Upload Resume';
    if (name) name.textContent = lastResumeName || (hasResume ? 'Resume saved' : '');
    if (previewBtn) {
      previewBtn.hidden = !hasResume;
      previewBtn.classList.toggle('is-visible', hasResume);
    }
  }

  async function openResumePreview() {
    if (!lastResumeDataUrl && !lastResumeLink) {
      setStatus('Upload a resume before previewing.', true);
      return;
    }
    setStatus('Opening resume preview…', false, 'busy');
    try {
      if (!lastResumeDataUrl) await loadSavedResume();
      const res = await send('OPEN_RESUME_PREVIEW', {
        webViewLink: lastResumeLink || null,
      });
      if (!res?.ok) throw new Error(res?.error || 'Could not open preview');
      setStatus(
        res.data?.mode === 'drive'
          ? 'Opened resume in Google Drive.'
          : 'Resume preview opened in a new tab.',
        false,
        'ok'
      );
    } catch (err) {
      setStatus(err.message || 'Could not open resume preview', true);
    }
  }

  function shortQuestionLabel(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= 72) return t;
    return `${t.slice(0, 69)}…`;
  }

  function buildProgressSeed(collected, resumeInputs) {
    const items = collected.map((q) => ({
      id: q.id,
      question: q.question,
      required: HS.isRequiredQuestion ? HS.isRequiredQuestion(q) : true,
      filled: false,
    }));
    if (resumeInputs?.length) {
      items.push({
        id: '__resume__',
        question: 'Resume/CV',
        required: true,
        filled: false,
      });
    }
    return HS.dedupeQuestionItems ? HS.dedupeQuestionItems(items) : items;
  }

  function dedupeProgress(items) {
    return HS.dedupeQuestionItems ? HS.dedupeQuestionItems(items) : items;
  }

  function progressStats(items) {
    const required = items.filter((i) => i.required);
    const optional = items.filter((i) => !i.required);
    const reqDone = required.filter((i) => i.filled).length;
    const reqTotal = required.length || items.length;
    const pct = reqTotal ? Math.round((reqDone / reqTotal) * 100) : 0;
    const bySource = {
      profile: 0,
      remembered: 0,
      openai: 0,
      page: 0,
      updated: 0,
      unmatched: 0,
    };
    for (const i of items) {
      if (i.id === '__resume__') continue;
      const s = i.source;
      if (s === 'profile') bySource.profile++;
      else if (s === 'remembered' || s === 'fixed') bySource.remembered++;
      else if (s === 'openai' || s === 'generated') bySource.openai++;
      else if (s === 'page') bySource.page++;
      else if (s === 'updated' || s === 'consent') bySource.updated++;
      else if (!i.filled || s === 'unmatched' || s === 'needs_user' || s === 'error') {
        bySource.unmatched++;
      }
    }
    return { required, optional, reqDone, reqTotal, pct, bySource };
  }

  function sourceBadge(source) {
    const s = String(source || '');
    if (s === 'profile') return { cls: 'is-profile', label: 'profile' };
    if (s === 'remembered' || s === 'fixed') return { cls: 'is-remembered', label: 'saved' };
    if (s === 'openai' || s === 'generated') return { cls: 'is-openai', label: 'AI' };
    if (s === 'page') return { cls: 'is-page', label: 'page' };
    if (s === 'consent') return { cls: 'is-consent', label: 'agree' };
    if (s === 'updated') return { cls: 'is-updated', label: 'updated' };
    if (s === 'unmatched' || s === 'needs_user') return { cls: 'is-unmatched', label: 'todo' };
    if (s === 'error') return { cls: 'is-unmatched', label: 'error' };
    return null;
  }

  function syncProgressPanelClass() {
    if (!panel) return;
    panel.classList.toggle('has-progress', !document.getElementById('hs-progress-view')?.hidden);
    panel.classList.toggle('has-progress-expanded', progressExpanded);
    panel.classList.toggle('has-progress-collapsed', !progressExpanded && !!progressItemsCache.length);
  }

  function collapseProgressBoard({ cancelAutofill = false } = {}) {
    if (cancelAutofill && progressBusy) {
      autofillCancelled = true;
      setBusy(['hs-autofill'], false);
      setStatus('Autofill cancelled', false);
    }
    progressExpanded = false;
    progressBusy = false;
    renderAutofillProgress(progressItemsCache, { busy: false, expanded: false });
  }

  function expandProgressBoard() {
    if (!progressItemsCache.length) return;
    progressExpanded = true;
    renderAutofillProgress(progressItemsCache, { busy: progressBusy, expanded: true });
  }

  function normalizeBusyLabel(label) {
    return String(label || 'Autofilling')
      .replace(/\s*\d+s\s*$/i, '')
      .replace(/[.\u2026]+$/g, '')
      .trim();
  }

  /** Lightweight status tick — keeps CSS animations alive (no full re-render). */
  function updateProgressBusyLabel(busyLabel, { waiting = false } = {}) {
    const root = document.getElementById('hs-progress-view');
    if (!root || root.hidden) return;
    const label = normalizeBusyLabel(busyLabel);
    root.classList.add('is-busy');
    root.classList.toggle('is-waiting', !!waiting);
    root.classList.toggle('is-filling', !waiting);
    const state = root.querySelector('.jr-progress-state');
    if (state) {
      state.textContent = label;
      state.classList.add('is-animated');
    }
    const meta = root.querySelector('.jr-progress-meta');
    if (meta) meta.textContent = `just now · ${label}`;
    const cancel = root.querySelector('.jr-progress-cancel');
    if (cancel) {
      cancel.textContent = 'Cancel';
      cancel.setAttribute('data-progress-action', 'cancel');
    }
  }

  function renderAutofillProgress(
    items,
    { busy = false, expanded = progressExpanded, busyLabel = '', waiting = false } = {}
  ) {
    const root = document.getElementById('hs-progress-view');
    if (!root) return;

    progressItemsCache = dedupeProgress(Array.isArray(items) ? items.slice() : []);
    progressBusy = !!busy;
    progressExpanded = !!expanded;

    if (!progressItemsCache.length) {
      root.hidden = true;
      root.innerHTML = '';
      root.classList.remove('is-expanded', 'is-collapsed', 'is-busy', 'is-waiting', 'is-filling');
      syncProgressPanelClass();
      return;
    }

    const company = jobInfo?.companyName || document.getElementById('hs-company')?.value || 'Company';
    const role =
      jobInfo?.roleName || document.getElementById('hs-role')?.value || 'Role on this page';
    const host = (() => {
      try {
        return new URL(jobInfo?.sourceUrl || location.href).hostname.replace(/^www\./, '');
      } catch {
        return location.hostname || 'this page';
      }
    })();

    const { required, optional, reqDone, reqTotal, pct, bySource } =
      progressStats(progressItemsCache);
    const matchPct = Math.max(pct, profileFieldStats(profileDraft).pct || 0);
    const cleanBusy = normalizeBusyLabel(busyLabel || 'Autofilling');
    const summaryLabel = busy
      ? cleanBusy
      : `${reqDone}/${reqTotal} required fields filled`;

    const sourceSummary = (() => {
      const bits = [];
      if (bySource.profile) bits.push(`${bySource.profile} profile`);
      if (bySource.remembered) bits.push(`${bySource.remembered} saved`);
      if (bySource.openai) bits.push(`${bySource.openai} AI`);
      if (bySource.page) bits.push(`${bySource.page} page`);
      if (bySource.updated) bits.push(`${bySource.updated} updated`);
      if (bySource.unmatched) bits.push(`${bySource.unmatched} unmatched`);
      return bits.join(' · ');
    })();

    const row = (item) => {
      const badge = sourceBadge(item.source || (!item.filled ? 'unmatched' : null));
      return `
      <li class="jr-progress-item ${item.filled ? 'is-done' : ''} ${badge ? badge.cls : ''}">
        <span class="jr-progress-mark" aria-hidden="true">${item.filled ? '✓' : '–'}</span>
        <span class="jr-progress-q">${escapeHtml(shortQuestionLabel(item.question))}</span>
        ${
          badge
            ? `<span class="jr-progress-src" title="Answer source">${escapeHtml(badge.label)}</span>`
            : ''
        }
      </li>`;
    };

    root.hidden = false;
    root.classList.toggle('is-expanded', progressExpanded);
    root.classList.toggle('is-collapsed', !progressExpanded);
    root.classList.toggle('is-busy', busy);
    root.classList.toggle('is-waiting', busy && waiting);
    root.classList.toggle('is-filling', busy && !waiting);

    if (!progressExpanded) {
      root.innerHTML = `
        <button type="button" class="jr-progress-collapsed" data-progress-action="expand" aria-expanded="false">
          <div class="jr-progress-collapsed-row">
            <span class="jr-progress-collapsed-label">${escapeHtml(`${reqDone}/${reqTotal} required fields filled`)}</span>
            <span class="jr-progress-collapsed-pct">${pct}%</span>
            <span class="jr-progress-collapsed-chevron" aria-hidden="true">⌃</span>
          </div>
          <div class="jr-progress-track" aria-hidden="true">
            <div class="jr-progress-fill" style="width:${pct}%"></div>
          </div>
        </button>`;
      syncProgressPanelClass();
      return;
    }

    root.innerHTML = `
      <div class="jr-progress-job">
        <div class="jr-progress-job-top">
          <div class="jr-progress-brand">
            <span class="jr-progress-logo" aria-hidden="true">${escapeHtml(companyInitial(company))}</span>
            <div class="jr-progress-brand-text">
              <div class="jr-progress-company">${escapeHtml(company)}</div>
              <div class="jr-progress-host">${escapeHtml(host)}</div>
            </div>
          </div>
          <div class="jr-progress-score" title="Autofill progress">
            <span class="jr-progress-score-ring" style="--hs-score:${matchPct}"></span>
            <span class="jr-progress-score-val">${matchPct}%</span>
          </div>
        </div>
        <div class="jr-progress-title">${escapeHtml(role)}</div>
        <div class="jr-progress-meta">${busy ? `just now · ${escapeHtml(cleanBusy)}` : 'just now'}</div>
      </div>
      <div class="jr-progress-board">
        <div class="jr-progress-summary">
          <div class="jr-progress-summary-row">
            <span class="jr-progress-state ${busy ? 'is-animated' : ''}">${escapeHtml(summaryLabel)}</span>
            <span class="jr-progress-pct">${pct}%</span>
            <button type="button" class="jr-progress-cancel" data-progress-action="${busy ? 'cancel' : 'close'}">${
              busy ? 'Cancel' : 'Close'
            }</button>
          </div>
          <div class="jr-progress-track ${busy ? 'is-indeterminate' : ''}" aria-hidden="true">
            <div class="jr-progress-fill" style="width:${busy && !pct ? '35%' : `${pct}%`}"></div>
          </div>
          ${
            sourceSummary
              ? `<div class="jr-progress-sources">${escapeHtml(sourceSummary)}</div>`
              : ''
          }
        </div>
        <div class="jr-progress-lists">
          ${
            required.length
              ? `<div class="jr-progress-section">
                  <h3 class="jr-progress-section-title">Required</h3>
                  <ul class="jr-progress-list">${required.map(row).join('')}</ul>
                </div>`
              : ''
          }
          ${
            optional.length
              ? `<div class="jr-progress-section">
                  <h3 class="jr-progress-section-title">Optional</h3>
                  <ul class="jr-progress-list">${optional.map(row).join('')}</ul>
                </div>`
              : ''
          }
        </div>
      </div>`;
    syncProgressPanelClass();
  }

  async function runAutofill() {
    autofillCancelled = false;
    stopAnswerLearningWatch();
    setBusy(['hs-autofill'], true);
    setStatus('Preparing autofill…', false, 'busy');
    const info = readFormJobInfo();

    try {
      if (!lastResumeDataUrl) await loadSavedResume();
      if (autofillCancelled) throw new Error('cancelled');
      if (!profileDraft) await loadProfileDraft();
      if (autofillCancelled) throw new Error('cancelled');

      let resumeInputs = HS.findResumeInputs ? HS.findResumeInputs() : [];
      let host = HS.detectHostResumeAutofill ? HS.detectHostResumeAutofill() : null;
      let collected = HS.collectQuestions();
      // Application forms embedded in an iframe (e.g. Greenhouse inside careers.airbnb.com)
      let frames = await collectFrames();
      const topHasHistory = !!HS.hasHistorySections?.();
      if (!collected.length && !resumeInputs.length && !host && !topHasHistory && !frames.length) {
        setStatus(
          'No application form found on this page yet. If the site shows an "Apply" button, open the form first, then run Autofill.',
          true
        );
        setBusy(['hs-autofill'], false);
        return;
      }

      // Slow, independent work starts now and runs while the resume is attached / the site parses it
      const wantsHistory = !!HS.fillHistory && (topHasHistory || frames.some((f) => f.result.hasHistory));
      const historyPromise = wantsHistory
        ? loadResumeHistory().catch((err) => {
            console.warn('Resume history failed', err);
            return { error: err.message || 'resume analysis failed' };
          })
        : Promise.resolve(null);
      const resumeContextPromise = buildResumeContext();

      const openaiStatus = await refreshOpenAIStatus();
      const needsAi = collected.some(
        (q) =>
          q.tag === 'textarea' ||
          /walk\s+us|explain|describe|tell\s+us|how\s+did\s+you\s+hear|share\s+a\s+time/i.test(
            q.question || ''
          )
      );
      if (needsAi && !openaiStatus?.configured) {
        setStatus(
          'OpenAI API key missing. Profile fields can still fill — set your key in the extension popup for essay answers.',
          true
        );
      }

      let progressItems = buildProgressSeed(collected, resumeInputs);
      renderAutofillProgress(progressItems, {
        busy: true,
        expanded: true,
        busyLabel: host ? 'Providing resume for Autofill from resume' : 'Autofilling',
        waiting: !!host,
      });

      let filled = 0;
      let resumeFilled = 0;
      let meta = {};
      let hostWaited = false;
      let hostCompleted = false;

      // Phase 1: feed resume so host "Autofill from resume" can run first
      let resumeFile = null;
      if (lastResumeDataUrl) {
        try {
          resumeFile = dataUrlToFile(
            lastResumeDataUrl,
            lastResumeName || 'resume.pdf',
            lastResumeMime || 'application/pdf'
          );
        } catch (err) {
          console.warn('Resume file build failed', err);
        }
      }

      if (resumeFile && HS.fillResumeInputs) {
        setStatus(
          host
            ? 'Attaching resume for page Autofill from resume…'
            : 'Attaching uploaded resume…',
          false,
          'busy'
        );
        resumeFilled = HS.fillResumeInputs(resumeFile);
        if (host && HS.feedHostResumeAutofill) {
          resumeFilled += HS.feedHostResumeAutofill(host, resumeFile) || 0;
        }
        if (resumeFilled > 0) steps.resume = true;
      } else if ((resumeInputs.length || host) && !lastResumeDataUrl) {
        setStatus('Upload a resume so Autofill can attach it for page Autofill.', true);
      }

      // Phase 2: wait ONLY for "Autofill from resume" (ignore other autofill tools)
      if (host && HS.waitForHostResumeAutofill) {
        if (host.isComplete()) {
          hostCompleted = true;
        } else {
          hostWaited = true;
          setStatus('Waiting for Autofill from resume to finish…', false, 'busy');
          renderAutofillProgress(progressItems, {
            busy: true,
            expanded: true,
            busyLabel: 'Waiting for Autofill from resume',
            waiting: true,
          });
          const waitResult = await HS.waitForHostResumeAutofill({
            timeoutMs: 45000,
            pollMs: 350,
            hostRoot: host.root,
            shouldCancel: () => autofillCancelled,
            onProgress: ({ elapsed }) => {
              const secs = Math.max(1, Math.round(elapsed / 1000));
              updateProgressBusyLabel(`Waiting for Autofill from resume · ${secs}s`, {
                waiting: true,
              });
              setStatus(`Waiting for Autofill from resume… (${secs}s)`, false, 'busy');
            },
          });
          if (waitResult?.cancelled) throw new Error('cancelled');
          hostCompleted = !!waitResult?.complete;
          if (waitResult?.timedOut) {
            setStatus(
              'Autofill from resume is taking longer than expected — continuing with King Star fill…',
              false,
              'busy'
            );
          } else if (hostCompleted) {
            setStatus('Autofill from resume finished — filling remaining fields…', false, 'busy');
          }
        }
      }

      if (autofillCancelled) throw new Error('cancelled');

      // Re-scan after host fill so already-filled fields are recognized
      collected = HS.collectQuestions();
      resumeInputs = HS.findResumeInputs ? HS.findResumeInputs() : [];
      frames = await collectFrames();
      const frameQuestions = frames.flatMap((f) =>
        f.result.questions.map((q) => ({ ...q, id: frameQid(f.frameId, q.id) }))
      );
      progressItems = buildProgressSeed(collected, resumeInputs).concat(
        frameQuestions.map((q) => ({ id: q.id, question: q.question, required: q.required !== false, filled: false }))
      );
      if (!resumeInputs.length && frames.some((f) => f.result.resumeInputs)) {
        progressItems.push({ id: '__resume__', question: 'Resume/CV', required: true, filled: false });
      }
      // Mark resume row if we attached a file
      const resumeSeed = progressItems.find((p) => p.id === '__resume__');
      if (resumeSeed && resumeFilled > 0) resumeSeed.filled = true;
      renderAutofillProgress(progressItems, {
        busy: true,
        expanded: true,
        busyLabel: 'Autofilling remaining fields',
        waiting: false,
      });

      const resumeContext = await resumeContextPromise;
      if (autofillCancelled) throw new Error('cancelled');

      const generateFor = (qs) =>
        send('GENERATE_ANSWERS', {
          questions: qs.map(({ id, question, tag, type, placeholder, options }) => ({
            id,
            question,
            tag,
            type,
            placeholder,
            options: HS.serializableOptions ? HS.serializableOptions(options) : options,
          })),
          companyName: info.companyName,
          roleName: info.roleName,
          jobDescription: info.jobDescription,
          resumeContext,
        });
      // Never fill cover letters — leave those for the user
      const fillableAnswers = (list) =>
        list.filter((a) => {
          if (!a.answer) return false;
          if (HS.isCoverLetterField?.(a.question, { placeholder: a.placeholder })) return false;
          if (/cover\s*letter/i.test(a.question || '')) return false;
          return true;
        });

      // Phase 3 request goes out now: the server matches / generates while history is filled below
      const allQuestions = collected.concat(frameQuestions);
      const generatePromise = allQuestions.length ? generateFor(allQuestions) : Promise.resolve(null);
      if (allQuestions.length) {
        setStatus(`Filling ${allQuestions.length} field(s) from profile, resume & OpenAI…`, false, 'busy');
      }

      // Phase 2b: Work / Employment history + Education straight from the resume (not fixed answers)
      let historyRows = [];
      const history = await historyPromise;
      if (autofillCancelled) throw new Error('cancelled');
      const historyData =
        history && !history.error && (history.work?.length || history.education?.length) ? history : null;
      if (history?.error) {
        setStatus(`Work/education history skipped — ${history.error}`, true);
      }
      if (historyData && HS.hasHistorySections?.()) {
        try {
          setStatus('Filling work & education history from your resume…', false, 'busy');
          const hist = await HS.fillHistory(historyData, { shouldCancel: () => autofillCancelled });
          historyRows = historyProgressRows(hist.entries, null);
        } catch (err) {
          if (err.message === 'cancelled') throw err;
          console.warn('History autofill failed', err);
        }
      }
      progressItems = progressItems.concat(historyRows);
      renderAutofillProgress(progressItems, {
        busy: true,
        expanded: true,
        busyLabel: 'Autofilling remaining fields',
        waiting: false,
      });

      let allAnswers = [];
      const res = await generatePromise;
      if (autofillCancelled) throw new Error('cancelled');
      if (res && !res.ok) throw new Error(res.error || 'Failed');
      allAnswers = res?.data?.answers || [];
      meta = res?.data?.meta || {};
      const keepRow = (p) =>
        p.id === '__resume__' || String(p.id).startsWith('__history_') || isFrameQid(p.id);

      const onFillItem = (item) => {
        if (autofillCancelled) return;
        const qk = progressQuestionKey(item.question);
        const idx = progressItems.findIndex(
          (p) => p.id === item.id || (!isFrameQid(p.id) && progressQuestionKey(p.question) === qk)
        );
        if (idx >= 0) progressItems[idx] = { ...progressItems[idx], ...item };
        else progressItems.push(item);
        progressItems = dedupeProgress(progressItems);
        renderAutofillProgress(progressItems, {
          busy: true,
          expanded: true,
          busyLabel: 'Autofilling remaining fields',
          waiting: false,
        });
      };

      if (collected.length) {
        const answers = fillableAnswers(allAnswers.filter((a) => !isFrameQid(a.id)));
        const result = await HS.fillAnswers(answers, { onItem: onFillItem });
        if (autofillCancelled) throw new Error('cancelled');
        filled = typeof result === 'number' ? result : result.filled || 0;
        if (result?.items) {
          progressItems = dedupeProgress(result.items.concat(progressItems.filter(keepRow)));
        }
      }

      // Embedded forms: each frame fills its own resume input, history entries and answers
      if (frames.length) {
        setStatus('Filling the embedded application form…', false, 'busy');
        const fr = await fillFrames(
          frames,
          fillableAnswers(allAnswers.filter((a) => isFrameQid(a.id))),
          historyData
        );
        if (autofillCancelled) throw new Error('cancelled');
        filled += fr.filled;
        resumeFilled += fr.resumeFilled;
        if (fr.resumeFilled > 0) steps.resume = true;
        const touched = new Set(fr.items.map((i) => i.id));
        progressItems = progressItems.filter((p) => !touched.has(p.id)).concat(fr.items);
        renderAutofillProgress(progressItems, {
          busy: true,
          expanded: true,
          busyLabel: 'Autofilling remaining fields',
          waiting: false,
        });
      }

      if (collected.length) {
        // Follow-up questions ("If yes, which visa?", "Please explain…") only appear after earlier
        // answers are set. Re-scan and answer anything new until the form stops growing.
        const askedKeys = new Set(collected.map((q) => progressQuestionKey(q.question)));
        for (let pass = 0; pass < 3 && !autofillCancelled; pass++) {
          await new Promise((r) => setTimeout(r, 450));
          const fresh = HS.collectQuestions().filter((q) => {
            const k = progressQuestionKey(q.question);
            return k && !askedKeys.has(k);
          });
          if (!fresh.length) break;
          fresh.forEach((q) => askedKeys.add(progressQuestionKey(q.question)));
          collected = collected.concat(fresh);
          setStatus(`Found ${fresh.length} follow-up question(s) — filling…`, false, 'busy');
          const more = await generateFor(fresh);
          if (autofillCancelled) throw new Error('cancelled');
          if (!more?.ok) break;
          const moreAnswers = more.data.answers || [];
          allAnswers = allAnswers.concat(moreAnswers);
          fresh.forEach((q) => {
            if (!progressItems.some((p) => p.id === q.id)) {
              progressItems.push({ id: q.id, question: q.question, filled: false, required: HS.isRequiredQuestion?.(q) });
            }
          });
          const freshIds = new Set(fresh.map((q) => q.id));
          const freshKeys = new Set(fresh.map((q) => progressQuestionKey(q.question)));
          await HS.fillAnswers(fillableAnswers(moreAnswers), {
            // Only report the new questions; earlier rows keep their state
            onItem: (item) => {
              if (!freshIds.has(item.id) && !freshKeys.has(progressQuestionKey(item.question))) return;
              if (item.filled) filled += 1;
              onFillItem(item);
            },
          });
        }
      }

      if (allAnswers.length) {
        // Attach source only when fill succeeded — don't show profile/saved on empty controls
        const byId = new Map(allAnswers.map((a) => [a.id, a]));
        progressItems = dedupeProgress(
          progressItems.map((item) => {
            if (item.id === '__resume__') return { ...item, source: item.filled ? 'page' : null };
            const a = byId.get(item.id);
            if (!a) return item;
            if (item.filled) {
              return {
                ...item,
                source: item.source || a.source || null,
                intent: item.intent || a.intent || null,
              };
            }
            return {
              ...item,
              source: item.source || 'unmatched',
              intent: item.intent || a.intent || null,
            };
          })
        );
        renderAutofillProgress(progressItems, {
          busy: true,
          expanded: true,
          busyLabel: 'Autofilling remaining fields',
          waiting: false,
        });
      }

      const resumeItem = progressItems.find((p) => p.id === '__resume__');
      if (resumeItem) {
        resumeItem.filled = resumeFilled > 0 || !!(lastResumeDataUrl && resumeInputs.length === 0);
      }
      renderAutofillProgress(progressItems, { busy: false, expanded: true });

      steps.autofill = filled > 0 || resumeFilled > 0 || hostCompleted;
      updateSteps();
      await persistDraft({ steps: { ...steps } });

      // Learning runs in the background (it may call the LLM) — don't hold the result on it
      rememberFilledAnswers()
        .then((bulk) => {
          if (bulk?.saved) refreshFixedCount().catch(() => {});
        })
        .catch(() => {
          /* non-fatal */
        });

      const consentCount = progressItems.filter((i) => i.source === 'consent' && i.filled).length;
      const { reqDone, reqTotal, bySource } = progressStats(progressItems);
      const src = meta.bySource || bySource || {};
      let msg = `Autofill · ${reqDone}/${reqTotal} required checked`;
      if (resumeFilled) msg += ` · resume attached`;
      if (hostWaited && hostCompleted) msg += ` · resume Autofill done`;
      else if (hostWaited && !hostCompleted) msg += ` · resume Autofill timeout`;
      if (consentCount) msg += ` · ${consentCount} agree checked`;
      if (src.profile || meta.fromProfile) msg += ` · ${src.profile || meta.fromProfile} profile`;
      if (src.remembered || meta.fromRemembered) {
        msg += ` · ${src.remembered || meta.fromRemembered} saved`;
      }
      if (src.openai || meta.generated) msg += ` · ${src.openai || meta.generated} AI`;
      if (src.unmatched || meta.needsUser) msg += ` · ${src.unmatched || meta.needsUser} unmatched`;
      if (meta.openaiError && filled < collected.length) {
        msg += `. OpenAI: ${meta.openaiError}`;
        setStatus(msg, true);
      } else {
        setStatus(msg, false, 'ok');
      }
      await refreshFixedCount();
      await refreshOpenAIStatus();

      // Keep learning: user edits after autofill are remembered for the next app
      startAnswerLearningWatch();

      // ATS often unlocks Yes/No after other fields settle — retry + sync progress
      const delayedAnswers = allAnswers || [];
      const retryChoiceFill = async () => {
        if (autofillCancelled || !HS.fillAnswers || !delayedAnswers.length) return;
        const open = (progressItemsCache || []).filter(
          (i) =>
            i.id !== '__resume__' &&
            (!i.filled || i.source === 'unmatched' || i.source === 'needs_user')
        );
        if (!open.length) {
          syncProgressFromUserEdits();
          return;
        }
        try {
          const subset = delayedAnswers.filter((a) => {
            if (!a?.answer) return false;
            const qk = progressQuestionKey(a.question);
            return open.some(
              (i) => i.id === a.id || progressQuestionKey(i.question) === qk
            );
          });
          if (!subset.length) {
            syncProgressFromUserEdits();
            return;
          }
          const retry = await HS.fillAnswers(subset, {
            onItem: (item) => {
              if (!item?.filled) return;
              const qk = progressQuestionKey(item.question);
              const idx = progressItemsCache.findIndex(
                (p) => p.id === item.id || progressQuestionKey(p.question) === qk
              );
              if (idx >= 0) {
                progressItemsCache[idx] = {
                  ...progressItemsCache[idx],
                  filled: true,
                  source: item.source || progressItemsCache[idx].source || 'updated',
                };
              }
            },
          });
          if (retry?.items) {
            progressItemsCache = dedupeProgress(progressItemsCache);
            renderAutofillProgress(progressItemsCache, { busy: false, expanded: true });
          }
        } catch (err) {
          console.warn('Delayed choice fill failed', err);
        }
        syncProgressFromUserEdits();
      };
      setTimeout(() => {
        retryChoiceFill();
      }, 900);
      setTimeout(() => {
        retryChoiceFill();
      }, 2200);
    } catch (err) {
      if (String(err?.message || err) === 'cancelled') {
        renderAutofillProgress(progressItemsCache, { busy: false, expanded: false });
        setStatus('Autofill cancelled', false);
      } else {
        renderAutofillProgress(progressItemsCache, { busy: false, expanded: true });
        setStatus(err.message || 'Autofill failed', true);
      }
    } finally {
      setBusy(['hs-autofill'], false);
      progressBusy = false;
      autofillCancelled = false;
    }
  }

  function pickResumeFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf,.doc,.docx,.txt,.rtf,application/pdf';
      input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.documentElement.appendChild(input);
      let settled = false;
      const finish = (err, file) => {
        if (settled) return;
        settled = true;
        input.remove();
        if (err) reject(err);
        else resolve(file);
      };
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) finish(new Error('No file selected'));
        else finish(null, file);
      });
      window.addEventListener(
        'focus',
        () => {
          setTimeout(() => {
            if (!settled && !input.files?.length) finish(new Error('No file selected'));
          }, 400);
        },
        { once: true }
      );
      input.click();
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
  }

  function showResumeLink(url) {
    if (url) lastResumeLink = url;
    syncResumeUI();
  }

  async function runResumeUpload() {
    setBusy(['hs-resume'], true);
    setStatus('Select your resume file…', false, 'busy');
    try {
      const file = await pickResumeFile();
      setStatus(`Saving ${file.name}…`, false, 'busy');
      const dataUrl = await fileToDataUrl(file);
      lastResumeDataUrl = dataUrl;
      lastResumeName = file.name;
      lastResumeMime = file.type || 'application/pdf';
      setStatus('Reading resume for Autofill…', false, 'busy');
      lastResumeText = await extractResumeText(file);

      // Always persist locally first so Save applied job can upload from storage
      if (!lastResumeMime || lastResumeMime === 'application/octet-stream') {
        const n = String(file.name || '').toLowerCase();
        if (n.endsWith('.docx')) {
          lastResumeMime =
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        } else if (n.endsWith('.doc')) lastResumeMime = 'application/msword';
        else if (n.endsWith('.pdf')) lastResumeMime = 'application/pdf';
      }

      const local = await send('SAVE_RESUME_LOCAL', {
        dataUrl: lastResumeDataUrl,
        fileName: lastResumeName,
        mimeType: lastResumeMime,
        resumeText: lastResumeText || '',
        webViewLink: null,
        fileId: null,
      });
      if (!local?.ok) throw new Error(local?.error || 'Could not save resume locally');

      let driveNote = '';
      const info = readFormJobInfo();
      try {
        setStatus(`Uploading ${file.name} to Google Drive…`, false, 'busy');
        const res = await send('UPLOAD_RESUME', {
          useStored: true,
          fileName: file.name,
          mimeType: lastResumeMime,
          companyName: info.companyName,
          roleName: info.roleName,
        });
        if (res?.ok && res.data?.webViewLink) {
          lastResumeLink = res.data.webViewLink;
          lastResumeFileId = res.data.fileId || null;
          driveNote = ' · saved to Google Drive';
          await send('SAVE_RESUME_LOCAL', {
            dataUrl: lastResumeDataUrl,
            fileName: lastResumeName,
            mimeType: lastResumeMime,
            resumeText: lastResumeText || '',
            webViewLink: lastResumeLink,
            fileId: lastResumeFileId,
          });
        } else {
          driveNote = ` · Drive upload failed: ${res?.error || 'connect Google Drive in the web app'}`;
        }
      } catch (err) {
        driveNote = ` · Drive upload failed: ${err.message || 'connect Google Drive in the web app'}`;
      }

      steps.resume = true;
      updateSteps();
      syncResumeUI();
      await persistDraft({
        resumeDriveLink: lastResumeLink,
        resumeDriveFileId: lastResumeFileId,
        resumeFileName: lastResumeName,
        steps: { ...steps },
      });
      setStatus(
        `Resume ready (${file.name})${driveNote}${lastResumeText ? ' · ready for AI answers' : ''}.`,
        !lastResumeLink,
        lastResumeLink ? 'ok' : 'busy'
      );
    } catch (err) {
      if (String(err.message || '').includes('No file selected')) {
        setStatus('Resume upload canceled.', false, 'ok');
      } else {
        setStatus(err.message || 'Resume upload failed', true);
      }
    } finally {
      setBusy(['hs-resume'], false);
    }
  }

  function appliedJobDedupeKey(info) {
    const url = String(info?.sourceUrl || location.href || '')
      .split('#')[0]
      .toLowerCase();
    const company = String(info?.companyName || '')
      .trim()
      .toLowerCase();
    const role = String(info?.roleName || '')
      .trim()
      .toLowerCase();
    return `${company}::${role}::${url}`;
  }

  /** Audible alarm + OS notification when an applied job is saved. */
  function playSaveAlarm() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      const beep = (start, freq, dur) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + dur + 0.02);
      };
      // Two-tone “alarm” chime
      beep(now, 880, 0.16);
      beep(now + 0.18, 1175, 0.22);
      setTimeout(() => {
        try {
          ctx.close();
        } catch {
          /* ignore */
        }
      }, 800);
    } catch (err) {
      console.warn('Alarm sound failed', err);
    }
  }

  async function notifyAppliedSaved(info) {
    playSaveAlarm();
    try {
      await send('NOTIFY_APPLIED_SAVED', {
        companyName: info?.companyName,
        roleName: info?.roleName,
      });
    } catch (err) {
      console.warn('Save notification failed', err);
    }
  }

  function pageLooksApplicationSubmitted() {
    try {
      const t = String(document.body?.innerText || '').slice(0, 16000);
      return /application (has been )?submitted|thanks for applying|thank you for (your )?application|application received|successfully applied|we('ve| have) received your application|your application was sent|application complete|submitted successfully/i.test(
        t
      );
    } catch {
      return false;
    }
  }

  function ensureApplicationSubmitWatch() {
    if (applySubmitWatchBound) return;
    applySubmitWatchBound = true;

    const maybeAutoSave = () => {
      if (view !== 'apply' || appliedSaveInFlight) return;
      if (!pageLooksApplicationSubmitted()) return;
      saveAppliedJob({ auto: true }).catch(() => {});
    };

    document.addEventListener(
      'submit',
      () => {
        setTimeout(maybeAutoSave, 1200);
        setTimeout(maybeAutoSave, 3500);
      },
      true
    );

    // Many ATS navigate or rewrite DOM after submit without a classic form submit
    const mo = new MutationObserver(() => {
      maybeAutoSave();
    });
    try {
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch {
      /* ignore */
    }

    setInterval(maybeAutoSave, 4000);
  }

  async function saveAppliedJob({ auto = false } = {}) {
    const formInfo = readFormJobInfo();
    const info = {
      ...(jobInfo || {}),
      ...formInfo,
      companyName: formInfo.companyName || jobInfo?.companyName || '',
      roleName: formInfo.roleName || jobInfo?.roleName || '',
      jobDescription: formInfo.jobDescription || jobInfo?.jobDescription || '',
      sourceUrl: formInfo.sourceUrl || jobInfo?.sourceUrl || location.href,
    };

    if (!info.companyName || !info.roleName) {
      const msg =
        'Company and role are required. Use “Add a new job for this page” first.';
      if (!auto) {
        alert(msg);
        setStatus(msg, true);
      }
      return { ok: false, skipped: true };
    }

    const hasDescription = !!String(info.jobDescription || '').trim();
    const hasResume = !!(lastResumeDataUrl || lastResumeLink || lastResumeName);
    if (!hasDescription || !hasResume) {
      const missing = [];
      if (!hasDescription) missing.push('job description');
      if (!hasResume) missing.push('resume');
      const msg = `Cannot save applied job — missing ${missing.join(' and ')}.`;
      if (!auto) {
        alert(msg);
        setStatus(msg, true);
      }
      return { ok: false, skipped: true };
    }

    const dedupeKey = appliedJobDedupeKey(info);
    if (auto && appliedSavedKeys.has(dedupeKey)) {
      return { ok: true, skipped: true };
    }
    if (appliedSaveInFlight) return { ok: false, skipped: true };

    appliedSaveInFlight = true;
    setBusy(['hs-save'], true);
    setStatus(
      auto
        ? 'Application submitted — saving job, resume & Drive files…'
        : 'Saving to Applied jobs · uploading resume & job info…',
      false,
      'busy'
    );

    try {
      // Restore local resume (e.g. Anthony_Fait_Flossy.docx) if panel was remounted
      if (!lastResumeDataUrl) {
        try {
          await loadSavedResume();
        } catch {
          /* optional */
        }
      }

      // Always try Drive upload from chrome.storage (background reads the file)
      let resumeUploadNote = '';
      const hasLocalResume = !!(lastResumeDataUrl || lastResumeName);
      if (hasLocalResume || lastResumeLink) {
        try {
          setStatus(
            `Uploading resume${lastResumeName ? ` (${lastResumeName})` : ''} to Google Drive…`,
            false,
            'busy'
          );
          const up = await send('UPLOAD_RESUME', {
            useStored: true,
            dataUrl: lastResumeDataUrl || undefined,
            fileName: lastResumeName || 'resume.pdf',
            mimeType: lastResumeMime || undefined,
            companyName: info.companyName,
            roleName: info.roleName,
          });
          if (up?.ok && up.data?.webViewLink) {
            lastResumeLink = up.data.webViewLink;
            lastResumeFileId = up.data.fileId || lastResumeFileId;
            resumeUploadNote = `resume on Drive (${lastResumeName || 'file'})`;
            syncResumeUI();
          } else if (lastResumeLink) {
            resumeUploadNote = 'existing resume link kept';
          } else {
            resumeUploadNote = `resume NOT on Drive: ${up?.error || 'upload failed — connect Google Drive in the web app'}`;
          }
        } catch (err) {
          console.warn('Resume Drive upload failed', err);
          if (lastResumeLink) {
            resumeUploadNote = 'existing resume link kept';
          } else {
            resumeUploadNote = `resume NOT on Drive: ${err.message || 'connect Google Drive'}`;
          }
        }
      } else {
        resumeUploadNote = 'no resume attached — use Replace Resume first';
      }

      let remembered = 0;
      try {
        const bulk = await rememberFilledAnswers();
        remembered = bulk.saved || 0;
      } catch (err) {
        console.warn('remember answers failed', err);
      }

      setStatus('Saving job + job-info .txt…', false, 'busy');
      const res = await send('SAVE_APPLIED_JOB', {
        companyName: info.companyName,
        roleName: info.roleName,
        jobDescription: info.jobDescription,
        sourceUrl: info.sourceUrl,
        resumeDriveLink: lastResumeLink || null,
        resumeDriveFileId: lastResumeFileId || null,
      });
      if (!res?.ok) throw new Error(res?.error || 'Save failed');

      appliedSavedKeys.add(dedupeKey);
      steps.save = true;
      steps.extract = true;
      if (lastResumeDataUrl || lastResumeLink) steps.resume = true;
      updateSteps();

      // Chrome notification + chime are fired by the background SAVE_APPLIED_JOB handler.

      await send('CLEAR_DRAFT_JOB');
      // Clear resume + job description after a successful save
      await clearResumeState();
      clearFormUI();
      setDescription('');
      const descInput = document.getElementById('hs-job-desc-input');
      if (descInput) descInput.value = '';

      const saveBtn = document.getElementById('hs-save');
      if (saveBtn) {
        saveBtn.textContent = 'Saved to Applied jobs';
        saveBtn.disabled = true;
      }

      const jobInfoOk = !!res.data?.jobInfoDriveLink;
      const parts = [
        'Saved to Applied jobs (web app)',
        resumeUploadNote,
        jobInfoOk ? 'job-info .txt on Drive' : null,
        remembered > 0 ? `remembered ${remembered} answer(s)` : null,
        res.data?.driveWarning || null,
      ].filter(Boolean);

      setStatus(parts.join(' · '), false, res.data?.driveWarning ? 'busy' : 'ok');
      return { ok: true, data: res.data };
    } catch (err) {
      setStatus(err.message || 'Save failed', true);
      return { ok: false, error: err.message };
    } finally {
      appliedSaveInFlight = false;
      setBusy(['hs-save'], false);
    }
  }

  async function saveFixed() {
    const q = document.getElementById('hs-fixed-q')?.value?.trim();
    const a = document.getElementById('hs-fixed-a')?.value?.trim();
    if (!q || !a) {
      setStatus('Enter both question pattern and answer.', true);
      return;
    }
    try {
      const res = await send('SAVE_FIXED_ANSWER', {
        questionPattern: q,
        answer: a,
      });
      if (!res?.ok) throw new Error(res?.error || 'Failed');
      document.getElementById('hs-fixed-q').value = '';
      document.getElementById('hs-fixed-a').value = '';
      await refreshFixedCount();
      setStatus('Answer saved for future applications.', false, 'ok');
    } catch (err) {
      setStatus(err.message || 'Could not save fixed answer', true);
    }
  }

  /* ---------- Boot ---------- */

  ensureDock();
  ensurePanel();
  // Open split panel by default on load / refresh (Jobright-style)
  openPanel().catch(() => {});

  window.addEventListener('resize', () => {
    if (panel?.classList.contains('hs-open')) applySplitLayout(true);
  });

  // Host job sites often re-render <html>/<body> and drop our UI
  setInterval(ensureUiAlive, 2000);
  try {
    const uiObserver = new MutationObserver(() => {
      if ((panel && !isMounted(panel)) || (dock && !isMounted(dock))) ensureUiAlive();
    });
    uiObserver.observe(document.documentElement, { childList: true, subtree: false });
  } catch {
    /* ignore */
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'HS_OPEN_PANEL') {
      openPanel()
        .then(() => {
          ensureUiAlive();
          sendResponse({ ok: true });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (msg.type === 'HS_SHOW_DOCK') {
      showDock();
      setPanelOpen(false);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'HS_EXTRACT') {
      openPanel()
        .then(async () => {
          if (!session.profileComplete) {
            setStatus('Complete profile setup before extracting jobs.', true);
            await renderView('setup');
            return;
          }
          await renderView('apply');
          await startAddNewJob({ forceLlm: !!msg.forceLlm });
        })
        .then(() => sendResponse({ ok: true, jobInfo: readFormJobInfo() }));
      return true;
    }
    if (msg.type === 'HS_RESET_DRAFT') {
      resetDraft().then(() => sendResponse({ ok: true }));
      return true;
    }
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.draftJob) return;
    const next = changes.draftJob.newValue;
    if (!next) {
      if (panel?.classList.contains('hs-open') && view === 'apply') clearFormUI();
      return;
    }
    if (panel?.classList.contains('hs-open') && view === 'apply') {
      applyJobInfo(next);
    }
  });
})();
