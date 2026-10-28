import OpenAI from 'openai';
import { structureJobDescription } from './cleanDescription.js';

let client = null;

function getClient(apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OpenAI API key not configured');
  if (!client || client._key !== key) {
    client = new OpenAI({ apiKey: key });
    client._key = key;
  }
  return client;
}

/**
 * Generate a short, clean answer for a complex application question.
 * style: 'brief' (1–2 sentences / short phrase) | 'essay' (short paragraph)
 */
export async function generateAnswer({
  question,
  companyName,
  roleName,
  jobDescription,
  fixedAnswers = [],
  resumeContext = '',
  apiKey,
  style = 'essay',
}) {
  const openai = getClient(apiKey);

  const fixedBlock =
    fixedAnswers.length > 0
      ? fixedAnswers
          .map(
            (a) =>
              `- Q pattern: "${a.question_pattern || a.questionPattern}" → Answer: "${a.answer}"`
          )
          .join('\n')
      : 'None yet.';

  const brief = style === 'brief';
  const lengthRule = brief
    ? '- Keep it short & clean: 1–2 sentences or a short phrase (about 8–35 words). No essay.'
    : '- Keep it short & clean: 2–4 sentences (about 50–100 words). Concrete, not fluffy.';

  const prompt = `Write a clear, professional answer for this job-application question.

Company: ${companyName || 'Unknown'}
Role: ${roleName || 'Unknown'}
Question: ${question}

Job description (excerpt):
${(jobDescription || '').slice(0, 2500)}

${resumeContext ? `Applicant resume / profile context:\n${resumeContext.slice(0, 6000)}` : ''}

Known profile facts (optional context only; do not invent identity data):
${fixedBlock}

Rules:
${lengthRule}
- Use resume/profile context when it helps; stay truthful to that material.
- Plain text only — no markdown, no bullets, no surrounding quotes.
- Do NOT invent first name, last name, email, phone, or similar personal fields.
- Sound human, specific, and professional.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: brief
          ? 'You write short, clean answers for simple application questions. Reply with only the answer text.'
          : 'You write strong, concise answers to behavioral / meaningful application questions. Reply with only the answer text.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.45,
    max_tokens: brief ? 120 : 280,
  });

  return (completion.choices[0]?.message?.content || '').trim();
}

/**
 * Extract company, role, and clean job description from page text via LLM.
 */
export async function extractJobFromPage({
  pageText,
  pageUrl,
  title,
  hints = {},
  apiKey,
}) {
  const openai = getClient(apiKey);
  const text = String(pageText || '').slice(0, 12000);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    max_tokens: 2500,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You extract job posting fields from messy webpage text.
Return ONLY valid JSON with keys:
companyName (string), roleName (string), jobDescription (string), location (string|null), confidence (number 0-1).

Rules for jobDescription:
- Include only the actual job posting content (about the role, responsibilities, requirements, benefits).
- ALWAYS use Markdown structure: ## headings for sections, - for bullet lists, blank lines between paragraphs.
- Never return one continuous paragraph when the posting has sections.
- Exclude UI chrome: Back to jobs, Apply, New, Share, Save, Sign in, cookie banners, nav, footers, employee counts, related jobs.
- Exclude screenshot/alt-text noise and map-pin-only lines unless location is part of the posting body.
- Keep it clean and readable. Do not invent content.`,
      },
      {
        role: 'user',
        content: `URL: ${pageUrl || 'unknown'}
Page title: ${title || 'unknown'}
Heuristic hints (may be wrong): ${JSON.stringify(hints)}

Page text:
${text}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('OpenAI returned invalid JSON for job extraction');
  }

  return {
    companyName: String(parsed.companyName || '').trim(),
    roleName: String(parsed.roleName || '').trim(),
    jobDescription: structureJobDescription(String(parsed.jobDescription || '').trim()),
    location: parsed.location ? String(parsed.location).trim() : null,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.7)),
    source: 'openai',
  };
}

/**
 * Match a question against fixed answer patterns (simple keyword / substring).
 * Prefer matchFixedAnswerSmart from fixedAnswers.js in routes.
 */
export function matchFixedAnswer(question, fixedAnswers) {
  if (!question || !fixedAnswers?.length) return null;
  const q = question.toLowerCase().trim();

  for (const fa of fixedAnswers) {
    const pattern = (fa.question_pattern || fa.questionPattern || '')
      .toLowerCase()
      .trim();
    if (!pattern) continue;
    if (q.includes(pattern) || pattern.includes(q)) return fa.answer;

    const keys = pattern.split(/[\s,/|]+/).filter((w) => w.length > 3);
    const hits = keys.filter((k) => q.includes(k));
    if (keys.length > 0 && hits.length / keys.length >= 0.6) return fa.answer;
  }
  return null;
}
