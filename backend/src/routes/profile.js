import { Router } from 'express';
import db from '../db.js';
import { requireUser } from '../userAuth.js';
import { EMPTY_PROFILE, syncProfileToFixedAnswers } from '../profileSync.js';

const router = Router();

function mergeProfile(existing, patch) {
  const base = existing || structuredClone(EMPTY_PROFILE);
  const next = {
    ...base,
    personal: { ...base.personal, ...(patch.personal || {}) },
    education: Array.isArray(patch.education) ? patch.education : base.education || [],
    equalEmployment: {
      ...base.equalEmployment,
      ...(patch.equalEmployment || {}),
    },
    completedSteps: {
      ...base.completedSteps,
      ...(patch.completedSteps || {}),
    },
  };

  if (typeof patch.profileComplete === 'boolean') {
    next.profileComplete = patch.profileComplete;
  } else {
    next.profileComplete = !!(
      next.completedSteps?.personal &&
      next.completedSteps?.education &&
      next.completedSteps?.equalEmployment
    );
  }
  return next;
}

router.get('/', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const profile = db.getProfile(user.id) || structuredClone(EMPTY_PROFILE);
  res.json({ ok: true, profile });
});

router.put('/', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const existing = db.getProfile(user.id) || structuredClone(EMPTY_PROFILE);
    const next = mergeProfile(existing, req.body || {});
    const saved = db.saveProfile(user.id, next);
    // Sync after every save so autofill can use partial profile (name/email) immediately
    const sync = syncProfileToFixedAnswers(saved);

    res.json({ ok: true, profile: saved, sync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/complete', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const existing = db.getProfile(user.id) || structuredClone(EMPTY_PROFILE);
    const next = mergeProfile(existing, {
      ...(req.body || {}),
      completedSteps: {
        personal: true,
        education: true,
        equalEmployment: true,
        ...(req.body?.completedSteps || {}),
      },
      profileComplete: true,
    });
    const saved = db.saveProfile(user.id, next);
    const sync = syncProfileToFixedAnswers(saved);
    res.json({ ok: true, profile: saved, sync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
