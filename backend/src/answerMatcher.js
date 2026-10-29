/**
 * LLM semantic layer for autofill:
 * - matchQuestionsToBank: map live application questions onto the answer bank
 *   (profile facts + fixed answers) by meaning, adapting the answer to the field's options.
 * - learnQuestions: for newly answered questions, find a same-meaning bank item to update,
 *   or produce a reusable (company-neutral) phrasing to store as a new fixed answer.
 */
import { getClient } from './openai.js';
import { normalizeQuestion } from './fixedAnswers.js';

const MODEL = 'gpt-4o-mini';
export const MATCH_MIN_CONFIDENCE = 0.75;
export const LEARN_MATCH_MIN_CONFIDENCE = 0.8;
const CHUNK = 40;

const SAME_MEANING_RULES = `A saved item matches a question only when it asks for the same information:
- Same subject AND the same qualifiers: country/region, location, skill or technology, timeframe, numeric threshold, work arrangement. Different wording is fine.
- Topic similarity is not enough: "years of experience with Python" is NOT "years of experience with Java"; "authorized to work in Canada" is NOT "authorized to work in the United States"; "willing to relocate to Austin" is NOT "willing to relocate".
- If unsure, it is not a match.`;

const MATCH_SYSTEM = `You match job-application questions to the applicant's saved answer bank (profile facts and previously given answers).
${SAME_MEANING_RULES}
For a matched question, return the value to put in the field, derived ONLY from the matched saved item:
- If the question lists options, return the single option (copied exactly) whose meaning equals the saved answer. If no option does, return no match.
- You may reformat the saved answer (e.g. "Yes" -> "Yes, I am authorized", phone or URL formatting), but never add facts that are not in the saved item.
Return JSON: {"results":[{"id":"q1","match":"b3" or null,"answer":"..." or null,"confidence":0.0-1.0}]} with exactly one entry per question.`;

const LEARN_SYSTEM = `You maintain an applicant's reusable answer bank for job applications.
For each new question the applicant answered, return:
1. "match": the id of the saved item that asks for the same information, or null.
${SAME_MEANING_RULES}
2. "confidence": 0.0-1.0 for the match.
3. "question": a reusable phrasing of the new question, used to recognize it on future applications:
- Neutral: remove company, team, product and job-title names ("at Acme", "for this role", "our team"); keep a place name if it changes the answer.
- Keep every qualifier that would change the answer (country/region, location, skill, timeframe, numbers, on-site/hybrid/remote, etc.).
- A concise question, at most 120 characters, without instructions ("Please select...", "Required").
- The applicant's given answer must still be a correct answer to it.
Return JSON: {"results":[{"i":0,"match":"b2" or null,"confidence":0.0-1.0,"question":"..."}]} with exactly one entry per item.`;

/** Stable key for exact-phrasing lookups (aliases). */
export function questionAliasKey(question) {
  return normalizeQuestion(question)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Options as a clean string list (drops placeholders like "Select…"). */
export function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => String(o ?? '').replace(/\s+/g, ' ').trim())
    .filter((o) => o && !/^(select|choose|please select|--)/i.test(o))
    .slice(0, 60);
}

function snapToOption(answer, options) {
  if (!options.length) return answer;
  const a = answer.toLowerCase();
  const exact = options.find((o) => o.toLowerCase() === a);
  if (exact) return exact;
  const partial = options.filter((o) => o.toLowerCase().includes(a) || a.includes(o.toLowerCase()));
  return partial.length === 1 ? partial[0] : null;
}

async function chatJson(apiKey, system, payload, maxTokens) {
  const completion = await getClient(apiKey).chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  });
  try {
    return JSON.parse(completion.choices[0]?.message?.content || '{}');
  } catch {
    return {};
  }
}

function bankForPrompt(bank) {
  const byShortId = new Map();
  const lines = bank.map((b, i) => {
    const id = `b${i + 1}`;
    byShortId.set(id, b);
    return { id, q: String(b.question).slice(0, 200), a: String(b.answer).slice(0, 200) };
  });
  return { lines, byShortId };
}

/**
 * questions: [{ question, type, options }]; bank: [{ id, kind, question, answer }]
 * Returns Map(questionIndex → { bankItem, answer, confidence }).
 */
export async function matchQuestionsToBank({ questions, bank, apiKey }) {
  const out = new Map();
  if (!questions.length || !bank.length) return out;
  const { lines, byShortId } = bankForPrompt(bank);

  for (let start = 0; start < questions.length; start += CHUNK) {
    const chunk = questions.slice(start, start + CHUNK).map((q, j) => {
      const options = normalizeOptions(q.options);
      return {
        id: `q${start + j + 1}`,
        q: String(q.question).slice(0, 400),
        type: q.type || q.tag || 'text',
        ...(options.length ? { options } : {}),
      };
    });
    const data = await chatJson(apiKey, MATCH_SYSTEM, { bank: lines, questions: chunk }, 3000);
    for (const r of Array.isArray(data.results) ? data.results : []) {
      const idx = Number(String(r.id || '').slice(1)) - 1;
      const q = questions[idx];
      const item = byShortId.get(String(r.match || ''));
      const confidence = Number(r.confidence) || 0;
      const raw = String(r.answer ?? '').trim();
      if (!q || !item || !raw || confidence < MATCH_MIN_CONFIDENCE) continue;
      const answer = snapToOption(raw, normalizeOptions(q.options));
      if (answer) out.set(idx, { bankItem: item, answer, confidence });
    }
  }
  return out;
}

/**
 * items: [{ question, answer, options }]; bank: [{ id, kind, question, answer }]
 * Returns array aligned with items: { matchItem|null, question } (question = phrasing to store).
 */
export async function learnQuestions({ items, bank, apiKey }) {
  const plan = items.map((it) => ({ matchItem: null, question: it.question }));
  if (!items.length) return plan;
  const { lines, byShortId } = bankForPrompt(bank);

  for (let start = 0; start < items.length; start += CHUNK) {
    const chunk = items.slice(start, start + CHUNK).map((it, j) => {
      const options = normalizeOptions(it.options);
      return {
        i: start + j,
        q: String(it.question).slice(0, 400),
        a: String(it.answer).slice(0, 200),
        ...(options.length ? { options } : {}),
      };
    });
    const data = await chatJson(apiKey, LEARN_SYSTEM, { bank: lines, items: chunk }, 3000);
    for (const r of Array.isArray(data.results) ? data.results : []) {
      const i = Number(r.i);
      if (!Number.isInteger(i) || !plan[i]) continue;
      const item = byShortId.get(String(r.match || ''));
      if (item && (Number(r.confidence) || 0) >= LEARN_MATCH_MIN_CONFIDENCE) plan[i].matchItem = item;
      const q = normalizeQuestion(r.question || '');
      if (q && q.length <= 160) plan[i].question = q;
    }
  }
  return plan;
}
