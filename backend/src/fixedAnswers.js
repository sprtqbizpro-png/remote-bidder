/**
 * Shared helpers for short reusable answers vs complex OpenAI questions.
 * Intent-based matching + learn/reuse for ATS phrasing drift.
 */

export function questionKeyFromPattern(questionPattern) {
  return String(questionPattern || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}

/** Normalize labels from ATS forms ("Name*", "Email *", etc.) */
export function normalizeQuestion(question) {
  return String(question || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s*\*+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip helper / instruction noise so matching sees the real question. */
export function stripHelperNoise(question) {
  let q = normalizeQuestion(question);
  q = q
    .replace(/\bplease reference the location\(s\) associated with this role\.?/gi, ' ')
    .replace(/\bplease reference[^.?!]{0,80}[.?!]?/gi, ' ')
    .replace(/\b(note|tip|hint)\s*:\s*[^.?!]{0,80}[.?!]?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return q;
}

const SHORT_FIELD_RE =
  /\b(first\s*name|last\s*name|given\s*name|family\s*name|surname|full\s*name|preferred\s*name|legal\s*name|middle\s*name|your\s*name|email|e-?mail|phone|mobile|telephone|cell|address|street|city|state|province|zip|postal|country|linkedin|github|portfolio|website|url|twitter|headline|current\s*(title|company|employer)|years?\s*(of\s*)?experience|salary|compensation|desired\s*pay|authorized\s*to\s*work|sponsorship|visa|relocate|start\s*date|notice\s*period|pronoun|gender|veteran|disability|race|ethnicity|hispanic|education|degree|university|school|gpa)\b/i;

const COMPLEX_QUESTION_RE =
  /share\s+a\s+time|tell\s+us\s+about|changed\s+your\s+mind|strongly\s+held\s+belief|latest\s+skill|taught\s+yourself|impactful\s+feedback|cover\s*letter|why\s+(do\s+you\s+want|are\s+you\s+interested|should\s+we\s+hire)|describe\s+(a\s+time|your\s+experience|how|when)|what\s+(makes|interests|excites|’.?s|is\s+the)|additional\s+(information|comments)|anything\s+else|motivation|challenge|accomplishment|strength|weakness|diversity|inclusion|essay|paragraph|briefly\s+explain|provide\s+an?\s+example|how\s+did\s+you|how\s+would\s+you|walk\s+us\s+through/i;

/** Canonical intents → detectors on the live question label */
const INTENT_DETECTORS = [
  { intent: 'email', re: /\be-?mail\b/i },
  { intent: 'phone', re: /\b(phone|mobile|telephone|cell)\b/i },
  { intent: 'first_name', re: /\b(first\s*name|given\s*name|fname)\b/i },
  { intent: 'last_name', re: /\b(last\s*name|family\s*name|surname|lname)\b/i },
  { intent: 'full_name', re: /^(name|full name|legal name|your name)$/i },
  { intent: 'linkedin', re: /\blinkedin\b/i },
  { intent: 'github', re: /\bgithub\b/i },
  { intent: 'portfolio', re: /\b(portfolio|personal\s*site|website)\b/i },
  { intent: 'address', re: /\b(street|address\s*line|current\s*address|^address$)\b/i },
  { intent: 'city', re: /(^|\b)city\b/i },
  { intent: 'state', re: /\b(state|province)\b/i },
  { intent: 'postal', re: /\b(zip|postal)\b/i },
  { intent: 'country', re: /\b(country\/?region|^country$|country of residence)\b/i },
  { intent: 'school', re: /\b(school|university|college)\b/i },
  { intent: 'major', re: /\b(major|field\s*of\s*study)\b/i },
  { intent: 'degree', re: /\bdegree\b/i },
  { intent: 'gpa', re: /\bgpa\b/i },
  { intent: 'pronouns', re: /\bpronoun/i },
  { intent: 'gender', re: /\bgender\b/i },
  { intent: 'disability', re: /\bdisability\b/i },
  { intent: 'veteran', re: /\bveteran\b/i },
  { intent: 'lgbtq', re: /\blgbtq\+?\b/i },
  { intent: 'race', re: /\b(race|ethnicity|identify your race|select your race)\b/i },
  { intent: 'hispanic', re: /\b(hispanic|latino|latina|latinx)\b/i },
  { intent: 'orientation', re: /\bsexual\s*orientation\b/i },
  { intent: 'citizen', re: /\b(citizen|citizenship)\b/i },
  {
    intent: 'work_auth',
    re: /\b(authorized\s+to\s+work|work\s+authorization|legally\s+authorized|legally\s+able\s+to\s+work|eligible\s+to\s+work|right\s+to\s+work)\b/i,
  },
  {
    intent: 'sponsorship',
    re: /\b(sponsor|sponsorship|visa\s+sponsorship|require\s+(an?\s+)?visa|immigration\s+sponsorship|employer\s+sponsor|h-?1b|tn\s+visa|o-?1\s+visa|work\s+visa\s+status)\b/i,
  },
  {
    intent: 'us_residence',
    re: /\b((live|living|reside|residing|based)\b.{0,48}\bunited\s+states|\bunited\s+states\b.{0,48}\b(live|living|reside|residing|based)|currently\s+(live|reside|based)\s+in\s+the\s+(u\.?s\.?|united\s+states))\b/i,
  },
  { intent: 'age_18', re: /\b(18\s+years?\s+(of\s+age|old)|at\s+least\s+18|over\s+18)\b/i },
  { intent: 'experience_years', re: /\byears?\s*(of\s*)?experience\b/i },
  { intent: 'hear_about', re: /\bhow\s+did\s+you\s+hear|where\s+did\s+you\s+hear|referral\s*source\b/i },
];

/** Intent → patterns that identify matching stored answers */
const INTENT_STORE_RE = {
  email: /e-?mail/i,
  phone: /phone|mobile|telephone|cell/i,
  first_name: /first\s*name|given\s*name|^fname$/i,
  last_name: /last\s*name|family\s*name|surname|^lname$/i,
  full_name: /^(name|full name|legal name|your name)$/i,
  linkedin: /linkedin/i,
  github: /github/i,
  portfolio: /portfolio|website|personal\s*site/i,
  address: /street|address/i,
  city: /^city$|\bcity\b/i,
  state: /state|province/i,
  postal: /zip|postal/i,
  country: /country/i,
  school: /school|university|college/i,
  major: /major|field\s*of\s*study/i,
  degree: /degree/i,
  gpa: /gpa/i,
  pronouns: /pronoun/i,
  gender: /gender/i,
  disability: /disability/i,
  veteran: /veteran/i,
  lgbtq: /lgbtq/i,
  race: /race|ethnicity|identify your race|select your race/i,
  hispanic: /hispanic|latino/i,
  orientation: /sexual\s*orientation/i,
  citizen: /citizen|citizenship/i,
  work_auth: /authorized|work\s*authorization|legally\s+authorized|legally\s+able|eligible\s+to\s+work|right\s+to\s+work/i,
  // Prefer sponsor/H-1B — bare "visa" alone is too broad
  sponsorship: /sponsor|sponsorship|visa\s+sponsorship|require\s+(an?\s+)?visa|employer\s+sponsor|h-?1b|work\s+visa\s+status/i,
  us_residence:
    /(live|living|reside|residing|based).{0,48}united\s+states|united\s+states.{0,48}(live|living|reside|residing|based)|currently\s+(live|reside|based)\s+in\s+the\s+(u\.?s\.?|united\s+states)/i,
  age_18: /18\s+years?\s+(of\s+age|old)|at\s+least\s+18|over\s+18/i,
  experience_years: /years?\s*(of\s*)?experience/i,
  hear_about: /how\s+did\s+you\s+hear|referral/i,
};

/** When learning a new phrasing, also store these canonical patterns for the same answer. */
const INTENT_CANONICAL_PATTERNS = {
  work_auth: [
    'Are you authorized to work in the United States?',
    'Authorized to work in the United States',
    'Are you legally authorized to work in the country where this role is located?',
    'Work authorization',
  ],
  sponsorship: [
    'Will you now or in the future require sponsorship?',
    'Do you require sponsorship?',
    'Will you now or in the future require visa sponsorship to work in the country this role is located?',
    'Visa sponsorship',
  ],
  disability: ['Do you have a disability?', 'Disability', 'Disability status'],
  veteran: ['Are you a veteran?', 'Veteran', 'Veteran status'],
  gender: ['What is your gender?', 'Gender', 'Gender identity', 'Please select your gender'],
  pronouns: ['What Are Your Pronouns?', 'Pronouns'],
  race: [
    'How would you identify your race?',
    'Race',
    'Race/Ethnicity',
    'Ethnicity',
    'Please select your race',
    'Please identify your race',
    'Race or ethnicity',
  ],
  hispanic: ['Are you Hispanic or Latino?', 'Hispanic or Latino'],
  lgbtq: ['Do you identify as LGBTQ+?', 'LGBTQ+'],
  orientation: ['How would you describe your sexual orientation?', 'Sexual orientation'],
  us_residence: [
    'Are you currently residing in the United States?',
    'Do you currently live in the United States?',
    'Are you based in the United States?',
  ],
  age_18: ['Are you 18 years of age or older?'],
  hear_about: ['How did you hear about us?', 'How did you hear about this role?'],
  email: ['Email', 'Email Address'],
  phone: ['Phone', 'Phone Number', 'Mobile'],
  linkedin: ['LinkedIn', 'LinkedIn URL'],
  full_name: ['Name', 'Full Name'],
  first_name: ['First Name'],
  last_name: ['Last Name'],
};

/** Intents stored as a single fixed-answer row (meaning-based, not one row per wording). */
export const COLLAPSIBLE_INTENTS = new Set([
  'sponsorship',
  'work_auth',
  'citizen',
  'disability',
  'veteran',
  'gender',
  'pronouns',
  'race',
  'hispanic',
  'lgbtq',
  'orientation',
  'us_residence',
  'age_18',
  'hear_about',
  'email',
  'phone',
  'linkedin',
  'github',
  'portfolio',
  'first_name',
  'last_name',
  'full_name',
]);

/** Human labels for Settings UI */
export const INTENT_DISPLAY_LABEL = {
  sponsorship: 'Visa sponsorship',
  work_auth: 'Work authorization',
  citizen: 'US citizenship',
  disability: 'Disability status',
  veteran: 'Veteran status',
  gender: 'Gender',
  pronouns: 'Pronouns',
  race: 'Race / ethnicity',
  hispanic: 'Hispanic or Latino',
  lgbtq: 'LGBTQ+',
  orientation: 'Sexual orientation',
  us_residence: 'US residence',
  age_18: 'Age 18+',
  hear_about: 'How did you hear about us?',
  email: 'Email',
  phone: 'Phone',
  linkedin: 'LinkedIn',
  github: 'GitHub',
  portfolio: 'Portfolio / website',
  first_name: 'First name',
  last_name: 'Last name',
  full_name: 'Full name',
};

export function intentStorageKey(intent) {
  return `intent_${String(intent || '').trim()}`;
}

export function displayLabelForIntent(intent, fallback = '') {
  if (intent && INTENT_DISPLAY_LABEL[intent]) return INTENT_DISPLAY_LABEL[intent];
  if (intent && INTENT_CANONICAL_PATTERNS[intent]?.[0]) {
    return INTENT_CANONICAL_PATTERNS[intent][0];
  }
  return fallback || intent || '';
}

/** Whether this intent should collapse to one stored answer. */
export function isCollapsibleIntent(intent) {
  return !!(intent && COLLAPSIBLE_INTENTS.has(intent));
}

/** Choice-style intents whose answers normalize to Yes/No/Decline. */
export function isYesNoIntent(intent) {
  return (
    intent === 'work_auth' ||
    intent === 'sponsorship' ||
    intent === 'citizen' ||
    intent === 'us_residence' ||
    intent === 'age_18' ||
    intent === 'disability' ||
    intent === 'hispanic' ||
    intent === 'lgbtq'
  );
}

/** Drop ATS helper scraps that aren't real questions (e.g. "(e.g., H-1B visa status)?"). */
export function isHelperFragmentPattern(pattern) {
  const q = normalizeQuestion(pattern);
  if (!q) return true;
  if (/^\(?\s*e\.?g\.?\s*[,:]/i.test(q)) return true;
  if (/^\([^)]{0,80}\)\??$/.test(q) && q.length < 60) return true;
  return false;
}

/** Infer Gender/Race from option labels when the DOM question is an EEO banner or option text. */
function intentFromOptions(fieldMeta = {}) {
  const opts = Array.isArray(fieldMeta.options) ? fieldMeta.options : [];
  if (!opts.length) return null;
  const blob = opts.map((o) => String(o || '').toLowerCase()).join(' || ');
  const hasMale = /\bmale\b|\bfemale\b|\bnon[- ]?binary\b/.test(blob);
  const hasRace =
    /hispanic|latino|asian|african\s+american|\bwhite\b|american\s+indian|pacific\s+islander|two\s+or\s+more\s+races|not\s+hispanic/.test(
      blob
    );
  if (hasRace && !hasMale) return 'race';
  if (hasRace && (blob.match(/hispanic|asian|african|\bwhite\b|indian|hawaiian|pacific|two\s+or\s+more/g) || []).length >= 2) {
    return 'race';
  }
  if (hasMale) return 'gender';
  if (/he\s*\/\s*him|she\s*\/\s*her|they\s*\/\s*them/.test(blob)) return 'pronouns';
  if (/protected\s+veteran|disabled\s+veteran|\bveteran\b/.test(blob)) return 'veteran';
  return null;
}

export function detectQuestionIntent(question, fieldMeta = {}) {
  const q = stripHelperNoise(question).toLowerCase();

  // Prefer specific name parts over generic "name"
  if (q && INTENT_DETECTORS.find((d) => d.intent === 'first_name').re.test(q)) return 'first_name';
  if (q && INTENT_DETECTORS.find((d) => d.intent === 'last_name').re.test(q)) return 'last_name';

  if (fieldMeta.type === 'email') return 'email';
  if (fieldMeta.type === 'tel') return 'phone';

  // EEO section headers / option-as-question → trust radio options
  const eeNoise =
    !q ||
    /u\.?\s*s\.?\s*equal\s+employment|equal\s+employment\s+opportunity|voluntary\s+self[- ]?identif/i.test(
      q
    ) ||
    /^decline\s+to\s+(self[- ]?identify|state)/i.test(q) ||
    /\(not\s+hispanic\s+or\s+latino\)/i.test(q);

  if (eeNoise) {
    const fromOpts = intentFromOptions(fieldMeta);
    if (fromOpts) return fromOpts;
  }

  if (q) {
    for (const { intent, re } of INTENT_DETECTORS) {
      if (intent === 'first_name' || intent === 'last_name') continue;
      if (re.test(q)) return intent;
    }
  }

  const fromOpts = intentFromOptions(fieldMeta);
  if (fromOpts) return fromOpts;

  // Bare name
  if (
    q &&
    (/^(name|full name|legal name|your name)$/i.test(q) ||
      (/\bname\b/i.test(q) && !/first|last|user|company|file|school|user/i.test(q) && q.length < 24))
  ) {
    return 'full_name';
  }
  return null;
}

export function isChoiceButtonField(fieldMeta = {}) {
  return fieldMeta.type === 'choice-button' || fieldMeta.tag === 'choice';
}

/** Cover letters are never auto-generated or filled. */
export function isCoverLetterField(question, fieldMeta = {}) {
  const q = normalizeQuestion(question).toLowerCase();
  const ph = String(fieldMeta.placeholder || '').toLowerCase();
  const name = String(fieldMeta.name || fieldMeta.id || '').toLowerCase();
  return /cover\s*letter/.test(q) || /cover\s*letter/.test(ph) || /cover.?letter|coverletter/.test(name);
}

/** Open-ended prompts that look "short" but should still get an OpenAI one-liner. */
export function isOpenEndedForAi(question, fieldMeta = {}) {
  const q = normalizeQuestion(question);
  if (!q) return false;
  if (isCoverLetterField(q, fieldMeta)) return false;
  if (isChoiceButtonField(fieldMeta)) return false;
  if (fieldMeta.tag === 'textarea') return true;
  if (COMPLEX_QUESTION_RE.test(q)) return true;
  if (/how\s+did\s+you\s+hear|referral|additional\s+(info|information|comments)|anything\s+else/i.test(q)) {
    return true;
  }
  return false;
}

export function answerGenerationStyle(question, fieldMeta = {}) {
  const q = normalizeQuestion(question);
  if (fieldMeta.tag === 'textarea' && q.length >= 40) return 'essay';
  if (/walk\s+us\s+through|tell\s+us|describe|explain|share\s+a\s+time|cover\s*letter/i.test(q)) {
    return 'essay';
  }
  return 'brief';
}

export function isShortPersonalField(question, fieldMeta = {}) {
  const q = normalizeQuestion(question);
  if (!q) return false;
  if (COMPLEX_QUESTION_RE.test(q)) return false;
  if (isOpenEndedForAi(q, fieldMeta) && !isChoiceButtonField(fieldMeta)) return false;
  if (isChoiceButtonField(fieldMeta)) return true;
  if (fieldMeta.tag === 'textarea' && q.length > 40) return false;
  if (detectQuestionIntent(q, fieldMeta)) return true;
  if (/^(name|email|phone|mobile|city|state|zip|country|address)$/i.test(q)) return true;
  if (SHORT_FIELD_RE.test(q) && q.length < 120) return true;
  if (fieldMeta.type === 'email' || fieldMeta.type === 'tel') return true;
  return false;
}

export function isComplexQuestion(question, fieldMeta = {}) {
  const q = normalizeQuestion(question);
  if (!q) return false;
  if (isCoverLetterField(q, fieldMeta)) return false;
  if (isChoiceButtonField(fieldMeta)) return false;
  if (detectQuestionIntent(q, fieldMeta) && !isOpenEndedForAi(q, fieldMeta)) return false;
  if (COMPLEX_QUESTION_RE.test(q)) return true;
  if (fieldMeta.tag === 'textarea' && q.length >= 25) return true;
  if (fieldMeta.tag === 'textarea' && /type here|enter your|write/i.test(fieldMeta.placeholder || '')) {
    if (q.length >= 20) return true;
  }
  if (q.length > 70 && !isShortPersonalField(q, fieldMeta)) return true;
  if (/\?/.test(q) && q.length > 45 && !isShortPersonalField(q, fieldMeta)) return true;
  return false;
}

export function isRepetitiveQA(question, answer, fieldMeta = {}) {
  const q = normalizeQuestion(question);
  const a = String(answer || '').trim();
  if (!q || !a) return false;
  if (isComplexQuestion(q, fieldMeta) && a.length > 120) return false;
  if (a.length > 220) return false;
  if (detectQuestionIntent(q, fieldMeta)) return true;
  if (isShortPersonalField(q, fieldMeta)) return true;
  if (/^(yes|no|n\/a|na|none|decline|prefer not|not say|\d+(\.\d+)?)\b/i.test(a)) return true;
  if (q.length <= 80 && a.length <= 100 && !/\n/.test(a) && fieldMeta.tag !== 'textarea') {
    return true;
  }
  // Radio/checkbox/choice/select/combobox answers are always worth remembering
  if (
    fieldMeta.type === 'radio' ||
    fieldMeta.type === 'checkbox' ||
    fieldMeta.type === 'choice-button' ||
    fieldMeta.type === 'combobox' ||
    fieldMeta.type === 'select-one' ||
    fieldMeta.tag === 'select'
  ) {
    return a.length <= 160;
  }
  // Short answers typed into application inputs
  if (a.length <= 160 && !/\n/.test(a) && fieldMeta.tag !== 'textarea') return true;
  return false;
}

function getAnswerByPattern(fixedAnswers, testFn) {
  for (const fa of fixedAnswers) {
    const pattern = normalizeQuestion(fa.question_pattern || fa.questionPattern || '').toLowerCase();
    if (testFn(pattern) && fa.answer) return String(fa.answer).trim();
  }
  return null;
}

/** Normalize Yes/No/Decline style answers onto a common vocabulary. */
export function normalizeChoiceAnswer(answer) {
  const a = String(answer || '').trim();
  if (!a) return '';
  if (/^(yes|y|true|1|checked)$/i.test(a) || /^yes\b/i.test(a)) return 'Yes';
  if (/^(no|n|false|0)$/i.test(a) || /^no\b/i.test(a)) return 'No';
  if (/decline|prefer not|not say|not to answer|don't wish|do not wish|rather not/i.test(a)) {
    return 'Prefer not to say';
  }
  return a;
}

/**
 * Match saved short answers to the current field via intents + aliases.
 */
export function matchFixedAnswerSmart(question, fixedAnswers, fieldMeta = {}) {
  if (!question || !fixedAnswers?.length) return null;
  const qRaw = stripHelperNoise(question);
  const q = qRaw.toLowerCase();
  const intent = detectQuestionIntent(qRaw, fieldMeta);

  if (intent === 'full_name') {
    const full =
      getAnswerByPattern(fixedAnswers, (p) => /^(name|full name|legal name|your name)$/i.test(p)) ||
      getAnswerByPattern(fixedAnswers, (p) => /^full\s*name|legal\s*name|your\s*name$/i.test(p));
    if (full) return full;
    const first = getAnswerByPattern(fixedAnswers, (p) => /first\s*name|given\s*name|^fname$/i.test(p));
    const last = getAnswerByPattern(fixedAnswers, (p) => /last\s*name|family\s*name|surname|^lname$/i.test(p));
    if (first && last) return `${first} ${last}`;
    if (first) return first;
  }

  if (intent === 'first_name') {
    const direct = getAnswerByPattern(fixedAnswers, (p) => /first\s*name|given\s*name|^fname$/i.test(p));
    if (direct) return direct;
    const full = getAnswerByPattern(fixedAnswers, (p) => /^(name|full name|legal name|your name)$/i.test(p));
    if (full) return full.split(/\s+/)[0];
  }

  if (intent === 'last_name') {
    const direct = getAnswerByPattern(fixedAnswers, (p) => /last\s*name|family\s*name|surname|^lname$/i.test(p));
    if (direct) return direct;
    const full = getAnswerByPattern(fixedAnswers, (p) => /^(name|full name|legal name|your name)$/i.test(p));
    if (full) {
      const parts = full.split(/\s+/);
      if (parts.length >= 2) return parts.slice(1).join(' ');
    }
  }

  if (intent && INTENT_STORE_RE[intent]) {
    // Prefer the single intent-keyed row (meaning-based store)
    const byIntent = fixedAnswers.find(
      (fa) =>
        (fa.intent === intent || fa.question_key === intentStorageKey(intent)) && fa.answer
    );
    if (byIntent?.answer) {
      const hit = String(byIntent.answer).trim();
      return isYesNoIntent(intent) ? normalizeChoiceAnswer(hit) : hit;
    }
    const hit = getAnswerByPattern(fixedAnswers, (p) => INTENT_STORE_RE[intent].test(p));
    if (hit) {
      return isYesNoIntent(intent) ? normalizeChoiceAnswer(hit) : hit;
    }
  }

  if (fieldMeta.type === 'email' || /e-?mail/i.test(q)) {
    const email = getAnswerByPattern(fixedAnswers, (p) => /e-?mail/i.test(p));
    if (email) return email;
  }
  if (fieldMeta.type === 'tel' || /phone|mobile|cell/i.test(q)) {
    const phone = getAnswerByPattern(fixedAnswers, (p) => /phone|mobile|telephone|cell/i.test(p));
    if (phone) return phone;
  }

  // Fuzzy: token overlap for remembered exact phrasings
  let best = null;
  let bestScore = 0;
  const qTokens = new Set(q.split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  for (const fa of fixedAnswers) {
    const pattern = normalizeQuestion(fa.question_pattern || fa.questionPattern || '').toLowerCase();
    if (!pattern || !fa.answer) continue;
    if (q === pattern) return String(fa.answer).trim();
    if (q.includes(pattern) && pattern.length >= 12) {
      const score = pattern.length / Math.max(q.length, 1);
      if (score > bestScore) {
        bestScore = score;
        best = String(fa.answer).trim();
      }
    }
    if (pattern.includes(q) && q.length >= 12) {
      const score = q.length / Math.max(pattern.length, 1);
      if (score > bestScore) {
        bestScore = score;
        best = String(fa.answer).trim();
      }
    }
    const pTokens = pattern.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    if (pTokens.length >= 3 && qTokens.size >= 3) {
      const hits = pTokens.filter((t) => qTokens.has(t)).length;
      const score = hits / Math.max(pTokens.length, qTokens.size);
      if (score >= 0.72 && score > bestScore) {
        bestScore = score;
        best = String(fa.answer).trim();
      }
    }
  }
  if (best && bestScore >= 0.45) return best;
  return null;
}

/**
 * When saving an answer, collapse to one intent-keyed row (meaning-based) instead of
 * duplicating every canonical phrasing in Settings.
 */
export function expandDerivedAnswers(question, answer) {
  const q = normalizeQuestion(question);
  const a = String(answer || '').trim();
  const intent = detectQuestionIntent(q);
  const out = [];

  // Full name → also learn first/last as their own intent rows
  if (/^(name|full name|legal name|your name)$/i.test(q) || intent === 'full_name') {
    const parts = a.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      out.push({
        questionPattern: displayLabelForIntent('first_name', 'First Name'),
        answer: parts[0],
        intent: 'first_name',
      });
      out.push({
        questionPattern: displayLabelForIntent('last_name', 'Last Name'),
        answer: parts.slice(1).join(' '),
        intent: 'last_name',
      });
      out.push({
        questionPattern: displayLabelForIntent('full_name', 'Full Name'),
        answer: a,
        intent: 'full_name',
      });
      return out;
    }
  }

  if (isCollapsibleIntent(intent)) {
    const normalized = isYesNoIntent(intent) ? normalizeChoiceAnswer(a) : a;
    out.push({
      questionPattern: displayLabelForIntent(intent, q),
      answer: normalized,
      intent,
    });
    return out;
  }

  // Non-collapsible: keep the live question wording as the pattern
  out.push({ questionPattern: q, answer: a, intent: intent || null });
  return out;
}

function toIntentRow(row, intent) {
  const answerRaw = String(row.answer || '').trim();
  return {
    ...row,
    intent,
    question_key: intentStorageKey(intent),
    question_pattern: displayLabelForIntent(intent, row.question_pattern || row.questionPattern || ''),
    answer: isYesNoIntent(intent) ? normalizeChoiceAnswer(answerRaw) || answerRaw : answerRaw || row.answer,
  };
}

/** Prefer non-empty, newer answers; avoid helper-fragment winners. */
function preferConsolidateRow(current, challenger) {
  const curA = String(current.answer || '').trim();
  const chA = String(challenger.answer || '').trim();
  if (chA && !curA) return true;
  if (!chA && curA) return false;

  const curHelper = isHelperFragmentPattern(current._sourcePattern || current.question_pattern || '');
  const chHelper = isHelperFragmentPattern(challenger._sourcePattern || challenger.question_pattern || '');
  if (!chHelper && curHelper) return true;
  if (chHelper && !curHelper) return false;

  const curTs = Date.parse(current.updated_at || '') || 0;
  const chTs = Date.parse(challenger.updated_at || '') || 0;
  if (chTs !== curTs) return chTs > curTs;

  // Stable: keep current when equal
  return false;
}

/**
 * Merge legacy duplicate fixed answers that share the same collapsible intent.
 * Keeps the best non-empty answer under intent_* key + display label.
 * Helper fragments (e.g. "(e.g., H-1B…)") fold into their intent or are dropped.
 */
export function consolidateFixedAnswerRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return { rows: [], changed: false };
  const byIntent = new Map();
  const passthrough = [];
  let changed = false;

  for (const row of rows) {
    const pattern = row.question_pattern || row.questionPattern || '';
    const intent = row.intent || detectQuestionIntent(pattern);
    const helper = isHelperFragmentPattern(pattern);

    if (!isCollapsibleIntent(intent)) {
      if (helper) {
        changed = true;
        continue;
      }
      passthrough.push({ ...row, intent: row.intent || null });
      continue;
    }

    const candidate = { ...toIntentRow(row, intent), _sourcePattern: pattern };
    const prev = byIntent.get(intent);
    if (!prev) {
      byIntent.set(intent, candidate);
      if (
        row.question_key !== candidate.question_key ||
        row.intent !== intent ||
        row.question_pattern !== candidate.question_pattern ||
        String(row.answer || '') !== String(candidate.answer || '')
      ) {
        changed = true;
      }
      continue;
    }

    changed = true;
    if (preferConsolidateRow(prev, candidate)) {
      byIntent.set(intent, { ...candidate, id: prev.id || candidate.id });
    }
  }

  const collapsed = [...byIntent.values()].map(({ _sourcePattern, ...rest }) => rest);
  if (collapsed.length + passthrough.length !== rows.length) changed = true;

  const next = [...collapsed, ...passthrough].sort((a, b) =>
    String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
  );
  return { rows: next, changed };
}
