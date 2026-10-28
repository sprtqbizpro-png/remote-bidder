function formatBytes(n) {
  const size = Number(n) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function estimateBytesFromDataUrl(dataUrl) {
  const b64 = String(dataUrl || '').split(',')[1] || '';
  return Math.floor((b64.length * 3) / 4);
}

function dataUrlToBlob(dataUrl) {
  const [header, data] = String(dataUrl).split(',');
  const mime = header.match(/:(.*?);/)?.[1] || 'application/octet-stream';
  const isBase64 = /;base64/i.test(header);
  if (isBase64) {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(data)], { type: mime });
}

function extOf(name = '') {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function kindFor(fileName, mimeType) {
  const ext = extOf(fileName);
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('pdf') || ext === 'pdf') return 'pdf';
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    return 'image';
  }
  if (
    ext === 'docx' ||
    mime.includes('wordprocessingml') ||
    mime.includes('officedocument.wordprocessingml')
  ) {
    return 'docx';
  }
  if (ext === 'doc' || mime === 'application/msword') return 'doc';
  if (mime.startsWith('text/') || ['txt', 'md', 'rtf', 'csv'].includes(ext)) return 'text';
  return 'other';
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadResume() {
  const { savedResume } = await chrome.storage.local.get({ savedResume: null });
  return savedResume;
}

function setEmptyState(message) {
  document.body.classList.add('state-empty');
  document.getElementById('file-name').textContent = 'No resume saved yet';
  document.getElementById('file-meta').textContent = message;
  document.getElementById('file-facts').innerHTML = '';
  const viewer = document.getElementById('viewer');
  viewer.innerHTML = `
    <div class="viewer-empty">
      <div class="file-icon" aria-hidden="true" style="margin:0 auto 4px">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </div>
      <h2>Upload a resume to preview</h2>
      <p>Open the King Star panel, choose Upload Resume, then return here to review it in a clean full-page preview.</p>
    </div>`;
}

function renderFacts(resume, bytes) {
  const facts = document.getElementById('file-facts');
  const rows = [
    ['Type', resume.mimeType || 'Document'],
    ['Size', formatBytes(bytes)],
    ['Saved', formatDate(resume.savedAt)],
  ];
  if (resume.webViewLink) rows.push(['Cloud', 'Google Drive']);
  facts.innerHTML = rows
    .map(
      ([k, v]) => `
      <li>
        <span class="k">${k}</span>
        <span class="v">${escapeHtml(v)}</span>
      </li>`
    )
    .join('');
}

function showFallback(viewer, resume, downloadBtn, options = {}) {
  const title = options.title || 'Preview not available in-browser';
  const body =
    options.body ||
    `${escapeHtml(resume.fileName || 'This file')} can’t be rendered here. Download it, or open it from Google Drive if synced.`;
  viewer.innerHTML = `
    <div class="viewer-fallback">
      <div class="file-icon" aria-hidden="true" style="margin:0 auto 4px">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </div>
      <h2>${title}</h2>
      <p>${body}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:8px">
        <button type="button" class="btn btn-secondary" id="fallback-download">Download file</button>
        ${
          resume.webViewLink
            ? `<a class="btn btn-ghost" href="${escapeHtml(resume.webViewLink)}" target="_blank" rel="noopener">Open in Drive</a>`
            : ''
        }
      </div>
    </div>`;
  document.getElementById('fallback-download')?.addEventListener('click', () => downloadBtn.click());
}

async function renderDocx(viewer, blob, resume, downloadBtn) {
  if (typeof mammoth === 'undefined' || !mammoth.convertToHtml) {
    showFallback(viewer, resume, downloadBtn, {
      title: 'Word preview unavailable',
      body: 'The DOCX converter failed to load. Download the file to view it.',
    });
    return;
  }

  viewer.innerHTML = `
    <div class="viewer-loading">
      <div class="spinner" aria-hidden="true"></div>
      <p>Converting Word document…</p>
    </div>`;

  try {
    const arrayBuffer = await blob.arrayBuffer();
    const result = await mammoth.convertToHtml(
      { arrayBuffer },
      {
        includeDefaultStyleMap: true,
        convertImage: mammoth.images.imgElement((image) =>
          image.read('base64').then((imageBuffer) => ({
            src: `data:${image.contentType};base64,${imageBuffer}`,
          }))
        ),
      }
    );

    const wrap = document.createElement('div');
    wrap.className = 'docx-preview';
    wrap.innerHTML = result.value || '<p class="docx-empty">This document appears to be empty.</p>';

    if (result.messages?.length) {
      const note = document.createElement('p');
      note.className = 'docx-note';
      note.textContent = 'Preview generated from your Word file. Layout may differ slightly from Microsoft Word.';
      wrap.prepend(note);
    } else {
      const note = document.createElement('p');
      note.className = 'docx-note';
      note.textContent = 'Preview generated from your Word file.';
      wrap.prepend(note);
    }

    viewer.innerHTML = '';
    viewer.appendChild(wrap);
    document.getElementById('file-meta').textContent = 'Word preview ready · attachable during Autofill';
  } catch (err) {
    console.error(err);
    showFallback(viewer, resume, downloadBtn, {
      title: 'Couldn’t preview this Word file',
      body: `${escapeHtml(err.message || 'Conversion failed')}. Try downloading the file, or re-save it as .docx / PDF.`,
    });
  }
}

async function renderPreview(resume) {
  const viewer = document.getElementById('viewer');
  const downloadBtn = document.getElementById('btn-download');
  const driveBtn = document.getElementById('btn-drive');

  document.title = `${resume.fileName || 'Resume'} · King Star`;
  document.getElementById('file-name').textContent = resume.fileName || 'Resume';
  document.getElementById('file-meta').textContent = 'Ready for autofill on application forms';

  const bytes = estimateBytesFromDataUrl(resume.dataUrl);
  renderFacts(resume, bytes);

  const blob = dataUrlToBlob(resume.dataUrl);
  const objectUrl = URL.createObjectURL(blob);
  const kind = kindFor(resume.fileName, resume.mimeType || blob.type);

  downloadBtn.disabled = false;
  downloadBtn.onclick = () => {
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = resume.fileName || 'resume.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  if (resume.webViewLink) {
    driveBtn.hidden = false;
    driveBtn.href = resume.webViewLink;
  } else {
    driveBtn.hidden = true;
  }

  if (kind === 'pdf') {
    viewer.innerHTML = `<iframe title="Resume PDF preview" src="${objectUrl}#toolbar=1&navpanes=0"></iframe>`;
    return;
  }

  if (kind === 'image') {
    viewer.innerHTML = `<img alt="Resume preview" src="${objectUrl}" />`;
    return;
  }

  if (kind === 'docx') {
    await renderDocx(viewer, blob, resume, downloadBtn);
    return;
  }

  if (kind === 'doc') {
    showFallback(viewer, resume, downloadBtn, {
      title: 'Old .doc format isn’t supported',
      body: 'Please re-save this resume as <strong>.docx</strong> or <strong>PDF</strong>, then upload again for in-browser preview.',
    });
    return;
  }

  if (kind === 'text') {
    const text = await blob.text();
    const pre = document.createElement('pre');
    pre.className = 'viewer-text';
    pre.textContent = text;
    viewer.innerHTML = '';
    viewer.appendChild(pre);
    return;
  }

  showFallback(viewer, resume, downloadBtn);
}

document.getElementById('btn-close')?.addEventListener('click', () => {
  window.close();
});

(async function init() {
  try {
    const resume = await loadResume();
    if (!resume?.dataUrl) {
      setEmptyState('Upload a resume from the King Star side panel first.');
      return;
    }
    await renderPreview(resume);
  } catch (err) {
    setEmptyState(err.message || 'Could not load resume preview.');
  }
})();
