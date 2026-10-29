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
} from '../fixedAnswers.js';

const router = Router();

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

router.post('/fixed/bulk', (req, res) => {
  const { answers, onlyRepetitive = true } = req.body || {};
  if (!Array.isArray(answers) || answers.length === 0) {
    return res.status(400).json({ error: 'answers array is required' });
  }

  let saved = 0;
  let skipped = 0;
  let unchanged = 0;
  const savedItems = [];
  const seenKeys = new Set();

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
      const key = isCollapsibleIntent(intent)
        ? intentStorageKey(intent)
        : questionKeyFromPattern(pattern);
      if (seenKeys.has(key)) {
        unchanged++;
        continue;
      }
      seenKeys.add(key);

      const existing =
        (intent && db.getFixedByIntent?.(intent)) || db.getFixedByKey(key);
      const nextAnswer = String(d.answer).trim();
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
    }
  }

  consolidateStore();
  res.json({ saved, skipped, unchanged, items: savedItems });
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
      remember = true,
    } = req.body || {};

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'questions array is required' });
    }

    const fixed = listFixed();

    // Prefer live profile values (from signed-in user) over stale fixed answers
    let profilePairs = [];
    const user = userFromToken(getBearerToken(req));
    if (user) {
      const profile = db.getProfile(sharedProfileUserId(user));
      if (profile) {
        profilePairs = profileToAnswerPairs(profile).map((p) => ({
          question_pattern: p.questionPattern,
          questionPattern: p.questionPattern,
          answer: p.answer,
          intent: detectQuestionIntent(p.questionPattern),
        }));
      }
    } else {
      // Fallback: first completed profile in store (single-user local setups)
      const profiles = Object.values(db.getAllProfiles() || {});
      const complete = profiles.find((p) => p?.completed);
      if (complete) {
        profilePairs = profileToAnswerPairs(complete).map((p) => ({
          question_pattern: p.questionPattern,
          questionPattern: p.questionPattern,
          answer: p.answer,
          intent: detectQuestionIntent(p.questionPattern),
        }));
      }
    }

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
    let generated = 0;
    let skippedShort = 0;
    let openaiError = null;

    for (const q of questions) {
      const questionText = normalizeQuestion(
        typeof q === 'string' ? q : q.question || q.label || ''
      );
      const fieldId = typeof q === 'object' ? q.id || q.name || null : null;
      const fieldMeta = {
        tag: typeof q === 'object' ? q.tag : undefined,
        type: typeof q === 'object' ? q.type : undefined,
        placeholder: typeof q === 'object' ? q.placeholder : undefined,
        options: typeof q === 'object' ? q.options : undefined,
      };

      if (isCoverLetterField(questionText, fieldMeta)) {
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

      let answer = matchFixedAnswerSmart(questionText, profilePairs, fieldMeta);
      let source = null;
      if (answer) {
        source = 'profile';
        fromProfile++;
      } else {
        answer = matchFixedAnswerSmart(questionText, answerBank, fieldMeta);
        if (answer) source = 'remembered';
      }

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
              apiKey: apiKey || getStoredOpenAIKey(),
              style: answerGenerationStyle(questionText, fieldMeta),
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

      const intent = detectQuestionIntent(questionText, fieldMeta);

      if (
        remember &&
        answer &&
        (source === 'openai' || source === 'profile') &&
        isRepetitiveQA(questionText, answer, fieldMeta)
      ) {
        for (const d of expandDerivedAnswers(questionText, answer)) {
          upsertFixed(d);
        }
      }

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
