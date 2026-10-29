import { Router } from 'express';
import {
  getAuthUrl,
  exchangeCode,
  isDriveConnected,
} from '../googleDrive.js';
import db, { flushDb } from '../db.js';
import {
  signin,
  logout,
  getBearerToken,
  userFromToken,
  sharedProfileUserId,
} from '../userAuth.js';
import { EMPTY_PROFILE } from '../profileSync.js';

const router = Router();

router.post('/signup', (_req, res) => {
  // Public/extension self-signup is not allowed. Owner adds members in the web app.
  res.status(403).json({
    error: 'Signup is disabled. Ask the owner to add your account, then sign in.',
  });
});

router.post('/signin', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = signin({ email, password });
    // Persist session before responding so other serverless instances can see it.
    await flushDb();
    res.json({
      ok: true,
      user: result.user,
      token: result.token,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/signout', async (req, res) => {
  const token = getBearerToken(req);
  if (token) logout(token);
  await flushDb();
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = getBearerToken(req);
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  // Members share the owner's profile for apply readiness.
  const profileId = sharedProfileUserId(user);
  const profile = db.getProfile(profileId) || structuredClone(EMPTY_PROFILE);
  res.json({
    ok: true,
    user,
    profileComplete: !!profile.profileComplete,
    completedSteps: profile.completedSteps || {},
  });
});

router.get('/google', (_req, res) => {
  try {
    const url = getAuthUrl();
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code');
    await exchangeCode(code);
    const frontend = process.env.FRONTEND_URL || 'http://localhost:5280';
    res.redirect(`${frontend}/settings?google=connected`);
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.status(500).send(`Google auth failed: ${err.message}`);
  }
});

router.get('/google/status', (_req, res) => {
  res.json({ connected: isDriveConnected() });
});

router.post('/google/disconnect', (_req, res) => {
  db.clearGoogleTokens();
  res.json({ ok: true });
});

router.get('/settings', (_req, res) => {
  const settings = db.getAllSettings();
  const frontendUrl = String(
    process.env.FRONTEND_URL || settings.frontend_url || 'http://localhost:5280'
  )
    .trim()
    .replace(/\/$/, '');
  res.json({
    openaiConfigured: !!(settings.openai_api_key || process.env.OPENAI_API_KEY),
    apiBaseUrl: settings.api_base_url || null,
    frontendUrl,
  });
});

router.post('/settings', (req, res) => {
  const { openaiApiKey, apiBaseUrl } = req.body || {};
  if (openaiApiKey) db.setSetting('openai_api_key', openaiApiKey);
  if (apiBaseUrl !== undefined) db.setSetting('api_base_url', apiBaseUrl || '');
  res.json({ ok: true });
});

export function getStoredOpenAIKey() {
  return db.getSetting('openai_api_key') || process.env.OPENAI_API_KEY || null;
}

export default router;
