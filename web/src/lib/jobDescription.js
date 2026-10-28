/**
 * Parse / structure job description text for display.
 */

const NOISE_LINE =
  /^(back to jobs?|back|apply( now)?|apply for this job|easy apply|save job|share|new|featured|show more|show less|see more|read more|sign in|log in)$/i;

const SECTION_RE =
  /^(#{1,3}\s*)?(about(\s+the)?\s+(role|job|company|team|us)|the\s+role|overview|summary|what\s+you.?ll\s+do|what\s+you\s+will\s+do|responsibilit(y|ies)|requirement(s)?|qualifications?|preferred\s+qualifications?|nice\s+to\s+have|must\s+have|benefits?|perks?|compensation|location|how\s+to\s+apply|who\s+you\s+are)\s*:?\s*$/i;

export function cleanJobDescription(text) {
  if (!text) return '';
  const lines = String(text)
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/);
  const out = [];

  for (let line of lines) {
    line = line.replace(/[ \t]+/g, ' ').trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }

    const plain = line.replace(/^#+\s*/, '').replace(/^•\s*/, '').replace(/^[-*]\s*/, '');
    if (NOISE_LINE.test(plain)) continue;
    if (/back to jobs/i.test(line) && line.length < 80) continue;
    if (/^[📍📌]/.test(line)) continue;
    if (/^(apply|new){1,3}$/i.test(line.replace(/\s+/g, ''))) continue;

    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function structureJobDescription(text) {
  let cleaned = cleanJobDescription(text);
  if (!cleaned) return '';

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

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseJobDescription(text) {
  const cleaned = structureJobDescription(text);
  if (!cleaned) return [];

  const blocks = [];
  const lines = cleaned.split('\n');
  let listItems = [];

  function flushList() {
    if (!listItems.length) return;
    blocks.push({ type: 'ul', items: listItems.slice() });
    listItems = [];
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushList();
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    if (
      line.length <= 60 &&
      /^[A-Z][A-Za-z0-9 /&'’-]+$/.test(line) &&
      /responsibilit|requirement|qualifi|benefit|about|overview|what you|who you|nice to have|preferred|location/i.test(
        line
      )
    ) {
      flushList();
      blocks.push({ type: 'h', level: 2, text: line });
      continue;
    }

    const bullet = line.match(/^([•\-\*]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      listItems.push(bullet[2].trim());
      continue;
    }

    if (line === '---') {
      flushList();
      blocks.push({ type: 'hr' });
      continue;
    }

    flushList();
    blocks.push({ type: 'p', text: line });
  }

  flushList();
  return blocks;
}

export function excerptDescription(text, n = 120) {
  const cleaned = structureJobDescription(text)
    .replace(/^#+\s+/gm, '')
    .replace(/^[-•*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length <= n ? cleaned : `${cleaned.slice(0, n)}…`;
}
