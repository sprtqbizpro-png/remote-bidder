import { Router } from 'express';
import db from '../db.js';
import { requireUser, sharedProfileUserId } from '../userAuth.js';
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

function loadSharedProfile(user) {
  const profileId = sharedProfileUserId(user);
  return db.getProfile(profileId) || structuredClone(EMPTY_PROFILE);
}

function saveSharedProfile(user, profile) {
  const profileId = sharedProfileUserId(user);
  return db.saveProfile(profileId, profile);
}

router.get('/', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const profile = loadSharedProfile(user);
  res.json({ ok: true, profile, shared: true });
});

router.put('/', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const existing = loadSharedProfile(user);
    const next = mergeProfile(existing, req.body || {});
    const saved = saveSharedProfile(user, next);
    // Sync after every save so autofill can use partial profile (name/email) immediately
    const sync = syncProfileToFixedAnswers(saved);

    res.json({ ok: true, profile: saved, sync, shared: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/complete', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const existing = loadSharedProfile(user);
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
    const saved = saveSharedProfile(user, next);
    const sync = syncProfileToFixedAnswers(saved);
    res.json({ ok: true, profile: saved, sync, shared: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
