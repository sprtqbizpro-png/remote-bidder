const apiStatus = document.getElementById('api-status');
const apiBaseUrl = document.getElementById('apiBaseUrl');
const openaiApiKey = document.getElementById('openaiApiKey');
const saveMsg = document.getElementById('save-msg');
const webLink = document.getElementById('web-link');

function showMsg(text, isError = false) {
  saveMsg.textContent = text || '';
  saveMsg.classList.toggle('is-error', !!isError);
}

async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (res?.ok) {
    apiBaseUrl.value = res.settings.apiBaseUrl || 'http://localhost:3847';
    openaiApiKey.value = res.settings.openaiApiKey || '';
    webLink.href = 'http://localhost:5280';
  }
}

async function checkHealth() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'HEALTH' });
    if (res?.ok) {
      apiStatus.textContent = 'API connected';
      apiStatus.className = 'pill ok';
    } else {
      apiStatus.textContent = 'API unreachable';
      apiStatus.className = 'pill err';
    }
  } catch {
    apiStatus.textContent = 'API unreachable';
    apiStatus.className = 'pill err';
  }
}

document.getElementById('btn-save').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings: {
      apiBaseUrl: apiBaseUrl.value.trim() || 'http://localhost:3847',
      openaiApiKey: openaiApiKey.value.trim(),
    },
  });
  showMsg('Settings saved.');
  await checkHealth();
});

async function injectContentScripts(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['content/overlay.css'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      'content/extractor.js',
      'content/descFormat.js',
      'content/autofill.js',
      'content/setup.js',
      'content/content.js',
    ],
  });
}

async function openPanelOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  if (!/^https?:/i.test(tab.url || '')) {
    throw new Error('Open a job page (http/https), then try again.');
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'HS_OPEN_PANEL' });
    return;
  } catch {
    /* content script missing — inject then retry */
  }
  await injectContentScripts(tab.id);
  await chrome.tabs.sendMessage(tab.id, { type: 'HS_OPEN_PANEL' });
}

document.getElementById('btn-open').addEventListener('click', async () => {
  try {
    await openPanelOnActiveTab();
    window.close();
  } catch (err) {
    showMsg(err.message || 'Reload this page, then try again.', true);
  }
});

document.getElementById('btn-extract').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'HS_EXTRACT' });
    if (res?.jobInfo) {
      showMsg(`${res.jobInfo.companyName} — ${res.jobInfo.roleName}`);
      await chrome.tabs.sendMessage(tab.id, { type: 'HS_OPEN_PANEL' });
    }
  } catch {
    showMsg('Reload this page, then try again.', true);
  }
});

loadSettings().then(checkHealth);
