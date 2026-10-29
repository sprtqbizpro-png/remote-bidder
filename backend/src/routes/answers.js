import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { generateAnswer } from '../openai.js';
import { getStoredOpenAIKey } from './auth.js';
import { getBearerToken, userFromToken, sharedProfileUserId } from '../userAuth.js';
import { profileToAnswerPairs } from '../profileSync.js';
import {
  isRepetitiveQA,
  isShortPersonalField,
  isComplexQuestion,
  isOpenEndedForAi,
  isCoverLetterField,
  answerGenerationStyle,
  questionKeyFromPattern,
  matchFixedAnswerSmart,
  normalizeQuestion,
  expandDerivedAnswers,
  detectQuestionIntent,
  consolidateFixedAnswerRows,
  isCollapsibleIntent,
  intentStorageKey,
  displayLabelForIntent,
  isFastPathIntent,
  canonicalQuestionForIntent,
} from '../fixedAnswers.js';
import {
  matchQuestionsToBank,
  learnQuestions,
  questionAliasKey,
  normalizeOptions,
} from '../answerMatcher.js';

const router = Router();

/** Fixed rows indexed by every exact phrasing they were answered under. */
function aliasIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    if (!row?.answer) continue;
    for (const key of [questionAliasKey(row.question_pattern), ...(row.aliases || [])]) {
      if (key && !index.has(key)) index.set(key, row);
    }
  }
  return index;
}

/** Profile facts for the signed-in user (or the single completed local profile). */
function loadProfilePairs(req) {
  const user = userFromToken(getBearerToken(req));
  let profile = null;
  if (user) {
    profile = db.getProfile(sharedProfileUserId(user));
  } else {
    profile = Object.values(db.getAllProfiles() || {}).find((p) => p?.completed) || null;
  }
  if (!profile) return [];
  return profileToAnswerPairs(profile).map((p) => ({
    question_pattern: p.questionPattern,
    questionPattern: p.questionPattern,
    answer: p.answer,
    intent: detectQuestionIntent(p.questionPattern),
  }));
}

/** Answer bank for semantic matching: profile facts first (source of truth), then fixed answers. */
function semanticBank(profilePairs, fixedRows) {
  return [
    ...profilePairs.map((p, i) => ({
      id: `profile:${i}`,
      kind: 'profile',
      question: p.questionPattern,
      answer: p.answer,
    })),
    ...fixedRows
      .filter((r) => r.answer)
      .map((r) => ({
        id: r.id,
        kind: 'fixed',
        question: (isCollapsibleIntent(r.intent) && canonicalQuestionForIntent(r.intent)) || r.question_pattern,
        answer: r.answer,
      })),
  ];
}

function mapFixed(row) {
  if (!row) return null;
  const intent = row.intent || null;
  const collapsed = isCollapsibleIntent(intent);
  return {
    id: row.id,
    questionKey: row.question_key,
    questionPattern: collapsed
      ? displayLabelForIntent(intent, row.question_pattern)
      : row.question_pattern,
    answer: row.answer,
    intent,
    meaningGrouped: collapsed,
    updatedAt: row.updated_at,
  };
}

/** Collapse legacy phrasing duplicates into one row per intent (persists when changed). */
function consolidateStore() {
  const { rows, changed } = consolidateFixedAnswerRows(db.listFixedAnswers());
  if (changed) db.replaceFixedAnswers(rows);
  return rows;
}

function listFixed() {
  return consolidateStore().map(mapFixed);
}

function upsertFixed({ questionKey, questionPattern, answer, intent: intentHint = null }) {
  const pattern = normalizeQuestion(questionPattern);
  const intent = intentHint || detectQuestionIntent(pattern);
  const collapse = isCollapsibleIntent(intent);
  const key = collapse
    ? intentStorageKey(intent)
    : questionKey || questionKeyFromPattern(pattern);
  const displayPattern = collapse ? displayLabelForIntent(intent, pattern) : String(pattern).slice(0, 200);

  return db.upsertFixedAnswer({
    id: uuidv4(),
    question_key: key,
    question_pattern: displayPattern.slice(0, 200),
    answer: String(answer).slice(0, 500),
    intent: collapse ? intent : intent || null,
  });
}

router.get('/fixed', (_req, res) => {
  res.json(listFixed());
});

router.post('/fixed', (req, res) => {
  const { questionKey, questionPattern, answer, intent } = req.body || {};
  if (!questionPattern || !answer) {
    return res.status(400).json({ error: 'questionPattern and answer are required' });
  }

  const { row, created } = upsertFixed({ questionKey, questionPattern, answer, intent });
  consolidateStore();
  const fresh =
    (row.intent && db.getFixedByIntent(row.intent)) || db.getFixedByKey(row.question_key) || row;
  res.status(created ? 201 : 200).json(mapFixed(fresh));
});

/**
 * Learn answers the applicant gave (or kept) on an application page.
 * - Meaning-grouped intents (email, gender, sponsorship…) update their single row directly.
 * - A phrasing seen before updates the row it belongs to.
 * - Anything else goes to the LLM: if a saved item already asks for the same information it is
 *   updated; otherwise a new fixed answer is stored under a reusable, company-neutral phrasing.
 *   Without an OpenAI key the live wording is stored as-is.
 */
router.post('/fixed/bulk', async (req, res) => {
  try {
    const { answers, onlyRepetitive = true, apiKey } = req.body || {};
    if (!Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ error: 'answers array is required' });
    }

    let saved = 0;
    let skipped = 0;
    let unchanged = 0;
    let learnedNew = 0;
    const savedItems = [];
    const seenKeys = new Set();
    const toLearn = [];
    consolidateStore();
    const aliases = aliasIndex(db.listFixedAnswers());

    for (const item of answers) {
      const questionPattern = normalizeQuestion(
        item.questionPattern || item.question || item.label || ''
      );
      const answer = item.answer;
      const fieldMeta = { tag: item.tag, type: item.type };
      if (!questionPattern || answer == null || String(answer).trim() === '') {
        skipped++;
        continue;
      }
      if (onlyRepetitive && !isRepetitiveQA(questionPattern, answer, fieldMeta)) {
        skipped++;
        continue;
      }

      const derived = expandDerivedAnswers(questionPattern, String(answer).trim());
      for (const d of derived) {
        const pattern = normalizeQuestion(d.questionPattern);
        const intent = d.intent || detectQuestionIntent(pattern);
        const nextAnswer = String(d.answer).trim();
        const collapse = isCollapsibleIntent(intent);
        const key = collapse ? intentStorageKey(intent) : `alias:${questionAliasKey(pattern)}`;
        if (seenKeys.has(key)) {
          unchanged++;
          continue;
        }
        seenKeys.add(key);

        if (collapse) {
          const existing = db.getFixedByIntent?.(intent) || db.getFixedByKey(key);
          if (existing && String(existing.answer || '').trim() === nextAnswer) {
            unchanged++;
            continue;
          }
          const { row, created } = upsertFixed({
            questionKey: key,
            questionPattern: pattern,
            answer: nextAnswer,
            intent,
          });
          saved++;
          savedItems.push({ ...mapFixed(row), created });
          continue;
        }

        const known = aliases.get(questionAliasKey(pattern));
        if (known) {
          if (String(known.answer || '').trim() === nextAnswer) {
            unchanged++;
          } else {
            const row = db.updateFixedAnswer(known.id, { answer: nextAnswer });
            saved++;
            if (row) savedItems.push({ ...mapFixed(row), created: false });
          }
          continue;
        }

        toLearn.push({
          question: pattern,
          answer: nextAnswer,
          intent: intent || null,
          options: normalizeOptions(item.options),
        });
      }
    }

    if (toLearn.length) {
      const key = apiKey || getStoredOpenAIKey();
      let plan = toLearn.map((it) => ({ matchItem: null, question: it.question }));
      if (key) {
        try {
          plan = await learnQuestions({
            items: toLearn,
            bank: semanticBank(loadProfilePairs(req), db.listFixedAnswers()),
            apiKey: key,
          });
        } catch (err) {
          console.warn('learnQuestions failed; storing live wording:', err.message);
        }
      }

      toLearn.forEach((item, i) => {
        const { matchItem, question } = plan[i];
        const alias = questionAliasKey(item.question);
        // Same meaning as a profile fact: the profile stays the source of truth
        if (matchItem?.kind === 'profile') {
          unchanged++;
          return;
        }
        if (matchItem?.kind === 'fixed') {
          const row = db.updateFixedAnswer(matchItem.id, { answer: item.answer, alias });
          if (row && String(matchItem.answer || '').trim() !== item.answer) {
            saved++;
            savedItems.push({ ...mapFixed(row), created: false });
          } else {
            unchanged++;
          }
          return;
        }
        const pattern = normalizeQuestion(question || item.question);
        const { row, created } = db.upsertFixedAnswer({
          id: uuidv4(),
          question_key: questionKeyFromPattern(pattern),
          question_pattern: pattern.slice(0, 200),
          answer: item.answer.slice(0, 500),
          intent: item.intent,
          aliases: [alias],
        });
        saved++;
        if (created) learnedNew++;
        savedItems.push({ ...mapFixed(row), created });
      });
    }

    consolidateStore();
    res.json({ saved, skipped, unchanged, learnedNew, items: savedItems });
  } catch (err) {
    console.error('bulk save fixed answers error:', err);
    res.status(500).json({ error: err.message || 'Bulk save failed' });
  }
});

router.delete('/fixed/:id', (req, res) => {
  if (!db.deleteFixedAnswer(req.params.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ ok: true });
});

router.post('/generate', async (req, res) => {
  try {
    const {
      questions,
      companyName,
      roleName,
      jobDescription,
      resumeContext,
      apiKey,
    } = req.body || {};

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'questions array is required' });
    }

    const fixed = listFixed();
    const fixedRows = db.listFixedAnswers();
    const aliases = aliasIndex(fixedRows);
    const openaiKey = apiKey || getStoredOpenAIKey();

    // Prefer live profile values (from signed-in user) over stale fixed answers
    const profilePairs = loadProfilePairs(req);

    // Fixed bank for matching — include intent field
    const answerBank = fixed.map((f) => ({
      question_pattern: f.questionPattern,
      questionPattern: f.questionPattern,
      question_key: f.questionKey,
      answer: f.answer,
      intent: f.intent,
    }));

    const results = [];
    let fromProfile = 0;
    let fromRemembered = 0;
    let matchedByAi = 0;
    let generated = 0;
    let skippedShort = 0;
    let openaiError = null;

    // ── Pass 1: deterministic matches (unambiguous intents, phrasings seen before)
    const items = questions.map((q) => {
      const questionText = normalizeQuestion(
        typeof q === 'string' ? q : q.question || q.label || ''
      );
      const fieldMeta = {
        tag: typeof q === 'object' ? q.tag : undefined,
        type: typeof q === 'object' ? q.type : undefined,
        placeholder: typeof q === 'object' ? q.placeholder : undefined,
        options: typeof q === 'object' ? normalizeOptions(q.options) : [],
      };
      const item = {
        id: typeof q === 'object' ? q.id || q.name || null : null,
        questionText,
        fieldMeta,
        intent: detectQuestionIntent(questionText, fieldMeta),
        answer: null,
        source: null,
        coverLetter: isCoverLetterField(questionText, fieldMeta),
      };
      if (item.coverLetter || !questionText) return item;

      if (isFastPathIntent(item.intent, questionText)) {
        const fromP = matchFixedAnswerSmart(questionText, profilePairs, fieldMeta, { fuzzy: false });
        const fromF = fromP ? null : matchFixedAnswerSmart(questionText, answerBank, fieldMeta, { fuzzy: false });
        if (fromP || fromF) {
          item.answer = fromP || fromF;
          item.source = fromP ? 'profile' : 'remembered';
          return item;
        }
      }
      const known = aliases.get(questionAliasKey(questionText));
      if (known?.answer) {
        item.answer = String(known.answer).trim();
        item.source = 'remembered';
      }
      return item;
    });

    // ── Pass 2: semantic match against profile + fixed answers (LLM); legacy fuzzy without a key
    const pending = items.filter((it) => !it.answer && !it.coverLetter && it.questionText);
    let semanticDone = false;
    if (pending.length && openaiKey) {
      try {
        const matches = await matchQuestionsToBank({
          questions: pending.map((it) => ({
            question: it.questionText,
            type: it.fieldMeta.type || it.fieldMeta.tag,
            options: it.fieldMeta.options,
          })),
          bank: semanticBank(profilePairs, fixedRows),
          apiKey: openaiKey,
        });
        matches.forEach(({ bankItem, answer }, idx) => {
          const it = pending[idx];
          it.answer = answer;
          it.source = bankItem.kind === 'profile' ? 'profile' : 'remembered';
          matchedByAi++;
          // Remember this phrasing so the next identical question skips the LLM
          if (bankItem.kind === 'fixed') {
            db.updateFixedAnswer(bankItem.id, { alias: questionAliasKey(it.questionText) });
          }
        });
        semanticDone = true;
      } catch (err) {
        openaiError = err.message || 'OpenAI matching failed';
      }
    }
    if (!semanticDone) {
      for (const it of pending) {
        const fromP = matchFixedAnswerSmart(it.questionText, profilePairs, it.fieldMeta);
        const fromF = fromP ? null : matchFixedAnswerSmart(it.questionText, answerBank, it.fieldMeta);
        if (fromP || fromF) {
          it.answer = fromP || fromF;
          it.source = fromP ? 'profile' : 'remembered';
        }
      }
    }

    // ── Pass 3: generate what the bank cannot answer
    for (const it of items) {
      const { questionText, fieldMeta, intent } = it;
      const fieldId = it.id;
      if (it.coverLetter) {
        results.push({
          id: fieldId,
          question: questionText,
          answer: '',
          source: 'skipped',
          intent: 'cover_letter',
          kind: 'cover_letter',
        });
        continue;
      }

      let answer = it.answer;
      let source = it.source;
      if (source === 'profile') fromProfile++;
      if (source === 'remembered') fromRemembered++;

      if (!answer) {
        const shortField = isShortPersonalField(questionText, fieldMeta);
        const complex = isComplexQuestion(questionText, fieldMeta);
        const openAiOk = complex || isOpenEndedForAi(questionText, fieldMeta) || !shortField;

        if (shortField && !openAiOk) {
          answer = '';
          source = 'unmatched';
          skippedShort++;
        } else if (openAiOk) {
          try {
            answer = await generateAnswer({
              question: questionText,
              companyName,
              roleName,
              jobDescription,
              fixedAnswers: answerBank,
              resumeContext,
              apiKey: openaiKey,
              style: answerGenerationStyle(questionText, fieldMeta),
              options: fieldMeta.options,
            });
            source = 'openai';
            generated++;
          } catch (err) {
            openaiError = err.message || 'OpenAI failed';
            answer = '';
            source = 'error';
          }
        } else {
          source = 'unmatched';
          skippedShort++;
        }
      }

      // Nothing is learned here: the extension posts the values that actually ended up on the
      // page (after the user's review) to /fixed/bulk, which stores them by meaning.
      results.push({
        id: fieldId,
        question: questionText,
        answer: answer || '',
        source: source || 'unmatched',
        intent,
      });
    }

    res.json({
      answers: results,
      meta: {
        fromProfile,
        fromRemembered,
        matchedByAi,
        generated,
        skippedShort,
        remembered: fixed.length,
        openaiError,
      },
    });
  } catch (err) {
    console.error('generate answers error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate answers' });
  }
});

export default router;
