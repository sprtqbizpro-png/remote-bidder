import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import db from './db.js';
import { EMPTY_PROFILE } from './profileSync.js';

const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const next = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(next, 'hex'));
  } catch {
    return false;
  }
}

export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email, name: user.name || '', created_at: user.created_at };
}

export function signup({ email, password, name }) {
  const e = String(email || '').trim().toLowerCase();
  const p = String(password || '');
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    const err = new Error('Valid email is required');
    err.status = 400;
    throw err;
  }
  if (p.length < 6) {
    const err = new Error('Password must be at least 6 characters');
    err.status = 400;
    throw err;
  }
  if (db.findUserByEmail(e)) {
    const err = new Error('An account with this email already exists');
    err.status = 409;
    throw err;
  }
  const user = db.createUser({
    id: uuidv4(),
    email: e,
    passwordHash: hashPassword(p),
    name: name || e.split('@')[0],
  });
  db.saveProfile(user.id, structuredClone(EMPTY_PROFILE));
  const session = issueSession(user.id);
  return { user, token: session.token, expiresAt: session.expiresAt };
}

export function signin({ email, password }) {
  const user = db.findUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    throw err;
  }
  const session = issueSession(user.id);
  return { user: publicUser(user), token: session.token, expiresAt: session.expiresAt };
}

export function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return db.createSession({ token, userId, expiresAt });
}

export function userFromToken(token) {
  const session = db.getSession(token);
  if (!session) return null;
  return publicUser(db.findUserById(session.userId));
}

export function logout(token) {
  db.deleteSession(token);
}

export function getBearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return req.headers['x-hs-token'] || req.body?.token || req.query?.token || null;
}

export function requireUser(req, res) {
  const token = getBearerToken(req);
  const user = userFromToken(token);
  if (!user) {
    res.status(401).json({ error: 'Sign in required' });
    return null;
  }
  req.hsUser = user;
  req.hsToken = token;
  return user;
}

/**
 * Ensure a known admin account exists (email/password from env).
 * Used so production Neon keeps the same login after migrate/redeploy.
 */
export function ensureAdminUserFromEnv() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  const name = String(process.env.ADMIN_NAME || '').trim() || 'Admin';
  if (!email || !password) return null;

  const existing = db.findUserByEmail(email);
  if (existing) {
    if (!verifyPassword(password, existing.passwordHash)) {
      const data = db.snapshot();
      const idx = data.users.findIndex((u) => u.id === existing.id);
      if (idx >= 0) {
        data.users[idx] = {
          ...data.users[idx],
          passwordHash: hashPassword(password),
          name: name || data.users[idx].name,
        };
        db.replaceAll(data);
      }
    }
    return publicUser(db.findUserByEmail(email));
  }

  const user = db.createUser({
    id: uuidv4(),
    email,
    passwordHash: hashPassword(password),
    name,
  });
  db.saveProfile(user.id, structuredClone(EMPTY_PROFILE));
  return user;
}
