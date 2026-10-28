const NOISE_LINE =
  /^(back to jobs?|back|apply( now)?|apply for this job|easy apply|save job|share|new|featured|show more|show less|see more|read more|sign in|log in)$/i;

const SECTION_RE =
  /^(#{1,3}\s*)?(about(\s+the)?\s+(role|job|company|team|us)|the\s+role|overview|summary|what\s+you.?ll\s+do|what\s+you\s+will\s+do|responsibilit(y|ies)|requirement(s)?|qualifications?|preferred\s+qualifications?|nice\s+to\s+have|must\s+have|benefits?|perks?|compensation|location|how\s+to\s+apply|who\s+you\s+are|you\s+will|we\s+are\s+looking)\s*:?\s*$/i;

/**
 * Turn flat / messy JD text into structured Markdown (headings + bullets + paragraphs).
 */
export function structureJobDescription(text) {
  let cleaned = cleanJobDescription(text);
  if (!cleaned) return '';

  // Already looks structured
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
      .replace(/\s*;\s+(?=[A-Z])/g, '\n- ')
      .trim();
  }

  const lines = cleaned.split(/\n/);
  const out = [];

  for (let line of lines) {
    line = line.replace(/[ \t]+/g, ' ').trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }

    // Promote section titles
    const plain = line.replace(/^#+\s*/, '').replace(/^[-•*]\s*/, '');
    if (SECTION_RE.test(plain) && !/^#+\s+/.test(line)) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(`## ${plain.replace(/:$/, '')}`);
      out.push('');
      continue;
    }

    // Normalize bullets
    if (/^[-•*]\s+/.test(line)) {
      out.push(`- ${line.replace(/^[-•*]\s+/, '')}`);
      continue;
    }

    // Split run-on bullet-like clauses inside a paragraph
    if (
      !/^#+\s+/.test(line) &&
      line.length > 160 &&
      (line.match(/;\s+/g) || []).length >= 2 &&
      !line.includes('http')
    ) {
      const parts = line.split(/;\s+/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 3 && parts.every((p) => p.length < 140)) {
        parts.forEach((p) => out.push(`- ${p.replace(/\.$/, '')}`));
        out.push('');
        continue;
      }
    }

    out.push(line);
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 20000);
}

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

  let cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  if (cleaned && !cleaned.includes('\n') && cleaned.length > 280) {
    cleaned = cleaned
      .replace(/\s+/g, ' ')
      .replace(
        /(Responsibilities|Requirements|Qualifications|About the (Role|Company|Team)|What You.?ll Do|Benefits|Nice to Have|Preferred)\s*:/gi,
        '\n\n## $1\n\n'
      )
      .replace(/([.!?])\s+(?=[A-Z])/g, '$1\n\n')
      .trim();
  }

  return cleaned;
}
