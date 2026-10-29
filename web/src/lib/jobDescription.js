/**
 * Parse / structure job description text for display.
 * Keep structureJobDescription in sync with backend/src/cleanDescription.js and extension/content/descFormat.js.
 */

const NOISE_LINE =
  /^(back to jobs?|back|apply( now)?|apply for this job|easy apply|save job|share|new|featured|show more|show less|see more|read more|sign in|log in)$/i;

const SECTION_RE =
  /^(about(\s+the)?\s+(role|job|position|opportunity|company|team|us|you)|the\s+role|the\s+opportunity|overview|summary|job\s+description|what\s+you.?ll\s+do|what\s+you\s+will\s+do|what\s+you.?ll\s+bring|what\s+we\s+offer|what\s+we.?re\s+looking\s+for|(key\s+)?responsibilit(y|ies)|((minimum|basic|preferred)\s+)?(requirements?|qualifications?)|nice\s+to\s+have|must\s+have|benefits?|perks?|compensation|location|how\s+to\s+apply|who\s+you\s+are|you\s+will|we\s+are\s+looking)\s*:?$/i;

/** Section labels inside a single run-on blob; a trailing colon is required so prose is never split. */
const INLINE_SECTION_RE =
  /\s*\b(About the Role|About the Job|About the Company|About Us|About You|What You.?ll Do|What You Will Do|What We Offer|Key Responsibilities|Responsibilities|Requirements|Minimum Qualifications|Preferred Qualifications|Qualifications|Nice to Have|Must Have|Benefits|Perks|Compensation|How to Apply|Who You Are)\s*:\s*/g;

const BULLET_RE = /^(?:[•●▪◦‣▸►■✓✔➤]\s*|[-*–]\s+)/;

/**
 * Normalize extracted text to light Markdown (## headings, "- " bullets) while keeping
 * the original paragraph and line breaks. Idempotent.
 */
export function structureJobDescription(text) {
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
}

export function cleanJobDescription(text) {
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

export function parseJobDescription(text) {
  const cleaned = structureJobDescription(text);
  if (!cleaned) return [];

  const blocks = [];
  const lines = cleaned.split('\n');
  let listItems = [];
  let listType = 'ul';
  let listStart = 1;
  let paraLines = [];

  function flushPara() {
    if (!paraLines.length) return;
    // Consecutive lines without a blank line between them form one paragraph (rendered with line breaks)
    blocks.push({ type: 'p', text: paraLines.join('\n') });
    paraLines = [];
  }

  function flushList() {
    flushPara();
    if (!listItems.length) return;
    blocks.push({ type: listType, items: listItems.slice(), start: listStart });
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

    const bullet = line.match(/^([•\-\*]|\d{1,2}[.)])\s+(.+)$/);
    if (bullet) {
      flushPara();
      const type = /^\d/.test(bullet[1]) ? 'ol' : 'ul';
      if (listItems.length && type !== listType) flushList();
      if (!listItems.length) {
        listType = type;
        listStart = type === 'ol' ? parseInt(bullet[1], 10) : 1;
      }
      listItems.push(bullet[2].trim());
      continue;
    }

    if (line === '---') {
      flushList();
      blocks.push({ type: 'hr' });
      continue;
    }

    if (listItems.length) flushList();
    paraLines.push(line);
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
