/**
 * Resume → structured work / education history for application-form autofill.
 * Independent of fixed answers: the resume is the only source.
 */
import crypto from 'node:crypto';
import { extractText, getDocumentProxy } from 'unpdf';
import { getClient } from './openai.js';

const cache = new Map(); // text hash → parsed history
const CACHE_MAX = 50;

/** Plain text from a resume data URL (PDF / plain text). DOCX text is extracted in the extension. */
export async function resumeTextFromDataUrl(dataUrl, name = '') {
  const m = String(dataUrl || '').match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!m) return '';
  const mime = m[1] || '';
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  if (/pdf/i.test(mime) || /\.pdf$/i.test(name)) {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return String(Array.isArray(text) ? text.join('\n') : text || '').trim();
  }
  if (/^text\//i.test(mime) || /\.txt$/i.test(name)) return buf.toString('utf8').trim();
  return '';
}

const SYSTEM = `You extract the work history and education from a resume for filling job-application forms.
Return JSON:
{"work":[{"title":"","company":"","location":"","startMonth":1-12|null,"startYear":2020|null,"endMonth":1-12|null,"endYear":2023|null,"current":false,"description":""}],
 "education":[{"school":"","degree":"","degreeLevel":"","field":"","startYear":null,"endYear":null,"gpa":""}]}
Rules:
- Only facts written in the resume; never invent. Use "" or null when a value is not stated.
- Most recent first. One work entry per position (two titles at one company = two entries).
- "current": true when the position is ongoing ("Present", "Current", "Now"); then endMonth/endYear are null.
- Months as numbers 1-12. If only a year is given, leave the month null.
- "description": the position's responsibilities/achievements as plain lines (one per bullet, no bullet symbols), at most 1500 characters.
- "degree": as written (e.g. "B.S. in Computer Science"). "degreeLevel": one of "High School", "Associate's", "Bachelor's", "Master's", "MBA", "Doctorate", "Certificate", or "" if unclear. "field": the major / field of study only.`;

function asYear(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 1950 && n < 2100 ? n : null;
}
function asMonth(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function normalizeHistory(data) {
  const work = (Array.isArray(data?.work) ? data.work : [])
    .map((w) => ({
      title: str(w.title),
      company: str(w.company),
      location: str(w.location),
      startMonth: asMonth(w.startMonth),
      startYear: asYear(w.startYear),
      endMonth: w.current ? null : asMonth(w.endMonth),
      endYear: w.current ? null : asYear(w.endYear),
      current: !!w.current,
      description: str(w.description, 1500),
    }))
    .filter((w) => w.title || w.company)
    .slice(0, 10);
  const education = (Array.isArray(data?.education) ? data.education : [])
    .map((e) => ({
      school: str(e.school),
      degree: str(e.degree),
      degreeLevel: str(e.degreeLevel, 40),
      field: str(e.field),
      startYear: asYear(e.startYear),
      endYear: asYear(e.endYear),
      gpa: str(e.gpa, 20),
    }))
    .filter((e) => e.school || e.degree)
    .slice(0, 6);
  return { work, education };
}

export async function parseResumeHistory({ text, apiKey }) {
  const clean = String(text || '').trim().slice(0, 20000);
  if (clean.length < 40) return { work: [], education: [] };
  const key = crypto.createHash('sha1').update(clean).digest('hex');
  if (cache.has(key)) return cache.get(key);

  const completion = await getClient(apiKey).chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 4000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: clean },
    ],
  });
  let data = {};
  try {
    data = JSON.parse(completion.choices[0]?.message?.content || '{}');
  } catch {
    /* empty history */
  }
  const history = normalizeHistory(data);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, history);
  return history;
}
