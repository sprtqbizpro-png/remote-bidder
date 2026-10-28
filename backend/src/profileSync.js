/**
 * Map completed profile fields into fixed_answers for autofill reuse.
 */
import { v4 as uuidv4 } from 'uuid';
import db from './db.js';
import {
  expandDerivedAnswers,
  isCollapsibleIntent,
  intentStorageKey,
  questionKeyFromPattern,
  consolidateFixedAnswerRows,
} from './fixedAnswers.js';

function pushPair(pairs, questionPattern, answer) {
  const a = String(answer ?? '').trim();
  if (!a) return;
  pairs.push({ questionPattern, answer: a });
}

export function profileToAnswerPairs(profile) {
  if (!profile) return [];
  const p = profile.personal || {};
  const ee = profile.equalEmployment || {};
  const pairs = [];

  // One canonical phrasing per meaning — expandDerivedAnswers / intent match
  // cover ATS wording variants at fill time.
  pushPair(pairs, 'First Name', p.firstName);
  pushPair(pairs, 'Middle Name', p.middleName);
  pushPair(pairs, 'Last Name', p.lastName);
  if (p.firstName && p.lastName) {
    pushPair(pairs, 'Full Name', `${p.firstName} ${p.lastName}`.trim());
  }
  pushPair(pairs, 'Email', p.email);
  pushPair(pairs, 'Phone', p.phone);
  pushPair(pairs, 'Phone Type', p.phoneType);
  pushPair(pairs, 'Address', p.addressLine);
  pushPair(pairs, 'Country', p.country);
  pushPair(pairs, 'State', p.state);
  pushPair(pairs, 'City', p.city);
  pushPair(pairs, 'County', p.county);
  pushPair(pairs, 'Postal Code', p.postalCode);
  pushPair(pairs, 'LinkedIn URL', p.linkedinUrl);
  pushPair(pairs, 'GitHub URL', p.githubUrl);
  pushPair(pairs, 'Portfolio URL', p.portfolioUrl);

  const edu = Array.isArray(profile.education) ? profile.education[0] : null;
  if (edu) {
    pushPair(pairs, 'School', edu.schoolName);
    pushPair(pairs, 'Major', edu.major);
    pushPair(pairs, 'Degree', edu.degreeType);
    pushPair(pairs, 'GPA', edu.gpa);
  }

  if (ee.usCitizen != null && ee.usCitizen !== '') {
    pushPair(pairs, 'Are you a citizen of the United States?', ee.usCitizen);
  }
  if (ee.usCitizen === 'Yes') {
    pushPair(pairs, 'Are you authorized to work in the United States?', 'Yes');
    pushPair(pairs, 'Will you now or in the future require visa sponsorship?', 'No');
  }

  pushPair(pairs, 'Do you have a disability?', ee.disability);
  pushPair(pairs, 'Are you a veteran?', ee.veteran);
  if (/^no$/i.test(String(ee.veteran || '').trim())) {
    pushPair(pairs, 'Veteran status', 'I am not a protected veteran');
  } else if (/^yes$/i.test(String(ee.veteran || '').trim())) {
    pushPair(
      pairs,
      'Veteran status',
      'I identify as one or more of the classifications of a protected veteran'
    );
  }
  pushPair(pairs, 'What is your gender?', ee.gender);
  pushPair(pairs, 'Do you identify as LGBTQ+?', ee.lgbtq);
  pushPair(pairs, 'How would you identify your race?', ee.race);
  pushPair(pairs, 'Are you Hispanic or Latino?', ee.hispanicLatino);
  pushPair(pairs, 'How would you describe your sexual orientation?', ee.sexualOrientation);
  pushPair(pairs, 'What Are Your Pronouns?', ee.pronouns);

  if (Array.isArray(ee.workCountries) && ee.workCountries.length) {
    pushPair(pairs, 'Countries where you want to work?', ee.workCountries.join(', '));
  }

  return pairs;
}

export function syncProfileToFixedAnswers(profile) {
  const pairs = profileToAnswerPairs(profile);
  let saved = 0;
  const seen = new Set();

  for (const { questionPattern, answer } of pairs) {
    const expanded = expandDerivedAnswers(questionPattern, answer);
    for (const item of expanded) {
      const intent = item.intent || null;
      const key = isCollapsibleIntent(intent)
        ? intentStorageKey(intent)
        : questionKeyFromPattern(item.questionPattern);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      db.upsertFixedAnswer({
        id: uuidv4(),
        question_key: key,
        question_pattern: item.questionPattern,
        answer: item.answer,
        intent: isCollapsibleIntent(intent) ? intent : intent || null,
      });
      saved += 1;
    }
  }

  const { rows, changed } = consolidateFixedAnswerRows(db.listFixedAnswers());
  if (changed) db.replaceFixedAnswers(rows);

  return { saved, pairs: pairs.length };
}

export const EMPTY_PROFILE = {
  personal: {
    firstName: '',
    middleName: '',
    lastName: '',
    email: '',
    phoneType: '',
    phone: '',
    addressLine: '',
    country: '',
    state: '',
    city: '',
    county: '',
    postalCode: '',
    linkedinUrl: '',
    githubUrl: '',
    portfolioUrl: '',
  },
  education: [],
  equalEmployment: {
    workCountries: [],
    usCitizen: '',
    disability: '',
    veteran: '',
    gender: '',
    lgbtq: '',
    race: '',
    hispanicLatino: '',
    sexualOrientation: '',
    pronouns: '',
  },
  completedSteps: {
    personal: false,
    education: false,
    equalEmployment: false,
  },
  profileComplete: false,
};
