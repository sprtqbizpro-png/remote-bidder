/**
 * Structure + render job descriptions in the extension panel.
 * Keep structureJobDescription in sync with backend/src/cleanDescription.js and web/src/lib/jobDescription.js.
 */
(function () {
  const HS = (window.HiddenStar = window.HiddenStar || {});

  const NOISE_LINE =
    /^(back to jobs?|back|apply( now)?|apply for this job|easy apply|save job|share|new|featured|show more|show less|see more|read more|sign in|log in)$/i;

  const SECTION_RE =
    /^(about(\s+the)?\s+(role|job|position|opportunity|company|team|us|you)|the\s+role|the\s+opportunity|overview|summary|job\s+description|what\s+you.?ll\s+do|what\s+you\s+will\s+do|what\s+you.?ll\s+bring|what\s+we\s+offer|what\s+we.?re\s+looking\s+for|(key\s+)?responsibilit(y|ies)|((minimum|basic|preferred)\s+)?(requirements?|qualifications?)|nice\s+to\s+have|must\s+have|benefits?|perks?|compensation|location|how\s+to\s+apply|who\s+you\s+are|you\s+will|we\s+are\s+looking)\s*:?$/i;

  /** Section labels inside a single run-on blob; a trailing colon is required so prose is never split. */
  const INLINE_SECTION_RE =
    /\s*\b(About the Role|About the Job|About the Company|About Us|About You|What You.?ll Do|What You Will Do|What We Offer|Key Responsibilities|Responsibilities|Requirements|Minimum Qualifications|Preferred Qualifications|Qualifications|Nice to Have|Must Have|Benefits|Perks|Compensation|How to Apply|Who You Are)\s*:\s*/g;

  const BULLET_RE = /^(?:[•●▪◦‣▸►■✓✔➤]\s*|[-*–]\s+)/;
  const NUMBERED_RE = /^\d{1,2}[.)]\s+/;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cleanJobDescription(text) {
    if (!text) return '';
    const out = [];
    const lines = String(text)
      .replace(/\r\n?/g, '\n')
      .replace(/[   ]/g, ' ')
      .replace(/[​-‍﻿]/g, '')
      .split('\n');
    for (let line of lines) {
      line = line.replace(/[ \t]+/g, ' ').trim();
      if (!line) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        continue;
      }
      const plain = line.replace(/^#+\s*/, '').replace(BULLET_RE, '');
      if (NOISE_LINE.test(plain)) continue;
      if (/back to jobs/i.test(line) && line.length < 80) continue;
      if (/^(apply|new){1,3}$/i.test(line.replace(/\s+/g, ''))) continue;
      out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Normalize extracted text to light Markdown (## headings, "- " bullets) while keeping
   * the original paragraph and line breaks. Idempotent.
   */
  HS.structureJobDescription = function structureJobDescription(text) {
    let cleaned = cleanJobDescription(text);
    if (!cleaned) return '';

    // Only a single run-on blob gets boundaries recovered — and only at explicit markers.
    if (!cleaned.includes('\n') && cleaned.length > 400) {
      cleaned = cleaned
        .replace(INLINE_SECTION_RE, '\n\n$1:\n')
        .replace(/\s+(?=[•●▪◦‣▸►■✓✔➤]\s*\S)/g, '\n')
        .trim();
    }

    const out = [];
    let danglingBullet = false;
    for (let line of cleaned.split('\n')) {
      line = line.trim();
      if (!line) {
        if (!danglingBullet && out.length && out[out.length - 1] !== '') out.push('');
        continue;
      }
      if (danglingBullet) {
        danglingBullet = false;
        out.push(`- ${line.replace(BULLET_RE, '')}`);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      const plain = line.replace(BULLET_RE, '');
      if (heading || (plain.length <= 60 && SECTION_RE.test(plain))) {
        const hashes = heading ? heading[1].slice(0, 3) : '##';
        const title = (heading ? heading[2] : plain).replace(/\s*:$/, '');
        if (out.length && out[out.length - 1] !== '') out.push('');
        out.push(`${hashes} ${title}`);
        out.push('');
        continue;
      }

      if (BULLET_RE.test(line) || /^[•●▪◦‣▸►■✓✔➤]$/.test(line)) {
        const body = line.replace(BULLET_RE, '').replace(/^[•●▪◦‣▸►■✓✔➤]$/, '').trim();
        // Bullet glyph rendered as its own element: attach it to the next line
        if (!body) danglingBullet = true;
        else out.push(`- ${body}`);
        continue;
      }

      out.push(line);
    }

    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
  };

  HS.renderJobDescriptionHtml = function renderJobDescriptionHtml(text) {
    const structured = HS.structureJobDescription(text);
    if (!structured) {
      return '<p class="hs-jd-empty">No description yet. Click Extract.</p>';
    }

    let html = '';
    let list = null; // 'ul' | 'ol'
    let para = [];

    function closeList() {
      if (list) {
        html += `</${list}>`;
        list = null;
      }
    }
    function flushPara() {
      if (para.length) {
        html += `<p class="hs-jd-p">${para.map(escapeHtml).join('<br>')}</p>`;
        para = [];
      }
    }
    function openList(kind, start = 1) {
      flushPara();
      if (list === kind) return;
      closeList();
      html += start > 1 ? `<${kind} class="hs-jd-list" start="${start}">` : `<${kind} class="hs-jd-list">`;
      list = kind;
    }

    for (const raw of structured.split('\n')) {
      const line = raw.trim();
      if (!line) {
        flushPara();
        closeList();
        continue;
      }
      const h = line.match(/^(#{1,3})\s+(.+)$/);
      if (h) {
        flushPara();
        closeList();
        const level = Math.min(h[1].length + 1, 4);
        html += `<h${level} class="hs-jd-h">${escapeHtml(h[2])}</h${level}>`;
        continue;
      }
      const bullet = line.match(/^[-•*]\s+(.+)$/);
      if (bullet) {
        openList('ul');
        html += `<li>${escapeHtml(bullet[1])}</li>`;
        continue;
      }
      if (NUMBERED_RE.test(line)) {
        openList('ol', parseInt(line, 10));
        html += `<li>${escapeHtml(line.replace(NUMBERED_RE, ''))}</li>`;
        continue;
      }
      if (line === '---') {
        flushPara();
        closeList();
        html += '<hr class="hs-jd-hr">';
        continue;
      }
      closeList();
      para.push(line);
    }
    flushPara();
    closeList();
    return html;
  };
})();
