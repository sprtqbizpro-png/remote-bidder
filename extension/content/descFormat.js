/**
 * Structure + render job descriptions in the extension panel.
 */
(function () {
  const HS = (window.HiddenStar = window.HiddenStar || {});

  const NOISE_LINE =
    /^(back to jobs?|back|apply( now)?|apply for this job|easy apply|save job|share|new|featured|show more|show less|see more|read more|sign in|log in)$/i;

  const SECTION_RE =
    /^(#{1,3}\s*)?(about(\s+the)?\s+(role|job|company|team|us)|the\s+role|overview|summary|what\s+you.?ll\s+do|what\s+you\s+will\s+do|responsibilit(y|ies)|requirement(s)?|qualifications?|preferred\s+qualifications?|nice\s+to\s+have|must\s+have|benefits?|perks?|compensation|location|how\s+to\s+apply|who\s+you\s+are|you\s+will|we\s+are\s+looking)\s*:?\s*$/i;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  HS.structureJobDescription = function structureJobDescription(text) {
    if (!text) return '';
    let cleaned = String(text)
      .replace(/\u00a0/g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .filter((line, i, arr) => {
        if (!line) return arr[i - 1] !== '';
        const plain = line.replace(/^#+\s*/, '').replace(/^[-•*]\s*/, '');
        if (NOISE_LINE.test(plain)) return false;
        if (/back to jobs/i.test(line) && line.length < 80) return false;
        return true;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const hasStructure =
      /^#+\s+/m.test(cleaned) ||
      /^[-•*]\s+/m.test(cleaned) ||
      (cleaned.includes('\n\n') && cleaned.split('\n').length >= 4);

    if (!hasStructure) {
      cleaned = cleaned
        .replace(/\s+/g, ' ')
        .replace(
          /\b(About the Role|About the Job|About the Company|About Us|The Role|Overview|Summary|What You.?ll Do|What You Will Do|Responsibilities|Requirements|Qualifications|Preferred Qualifications|Nice to Have|Must Have|Benefits|Perks|Compensation|Location|How to Apply|Who You Are)\s*:?\s*/gi,
          '\n\n## $1\n\n'
        )
        .replace(/([.!?])\s+(?=[A-Z])/g, '$1\n\n')
        .replace(/\s*[•●▪︎]\s*/g, '\n- ')
        .trim();
    }

    const lines = cleaned.split(/\n/);
    const out = [];
    for (let line of lines) {
      line = line.trim();
      if (!line) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        continue;
      }
      const plain = line.replace(/^#+\s*/, '').replace(/^[-•*]\s*/, '');
      if (SECTION_RE.test(plain) && !/^#+\s+/.test(line)) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        out.push(`## ${plain.replace(/:$/, '')}`);
        out.push('');
        continue;
      }
      if (/^[-•*]\s+/.test(line)) {
        out.push(`- ${line.replace(/^[-•*]\s+/, '')}`);
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

    const lines = structured.split('\n');
    let html = '';
    let inList = false;

    function closeList() {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
    }

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        closeList();
        continue;
      }
      const h = line.match(/^(#{1,3})\s+(.+)$/);
      if (h) {
        closeList();
        const level = Math.min(h[1].length + 1, 4);
        html += `<h${level} class="hs-jd-h">${escapeHtml(h[2])}</h${level}>`;
        continue;
      }
      const bullet = line.match(/^[-•*]\s+(.+)$/);
      if (bullet) {
        if (!inList) {
          html += '<ul class="hs-jd-list">';
          inList = true;
        }
        html += `<li>${escapeHtml(bullet[1])}</li>`;
        continue;
      }
      closeList();
      html += `<p class="hs-jd-p">${escapeHtml(line)}</p>`;
    }
    closeList();
    return html;
  };
})();
