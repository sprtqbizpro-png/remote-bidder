import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import db from './db.js';
import { EMPTY_PROFILE } from './profileSync.js';

const SESSION_DAYS = 30;
const DEFAULT_OWNER_EMAIL = 'anthonyfait.digital@gmail.com';

export function getOwnerEmail() {
  return String(process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || DEFAULT_OWNER_EMAIL)
    .trim()
    .toLowerCase();
}

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

export function resolveRole(user) {
  if (!user) return 'member';
  if (user.role === 'owner') return 'owner';
  if (String(user.email || '').toLowerCase() === getOwnerEmail()) return 'owner';
  return 'member';
}

/** Owner account used for the shared team profile. */
export function findOwnerUser() {
  const byEmail = db.findUserByEmail(getOwnerEmail());
  if (byEmail) return byEmail;
  return db.listUsers().find((u) => resolveRole(u) === 'owner') || null;
}

/**
 * All members share the owner's application profile.
 * Falls back to the signed-in user if no owner exists yet.
 */
export function sharedProfileUserId(user) {
  const owner = findOwnerUser();
  return owner?.id || user?.id || null;
}

export function publicUser(user) {
  if (!user) return null;
  const role = resolveRole(user);
  return {
    id: user.id,
    email: user.email,
    name: user.name || '',
    role,
    isOwner: role === 'owner',
    created_at: user.created_at,
  };
}

export function signup() {
  const err = new Error(
    'Signup is disabled. Ask the owner to add your account, then sign in.'
  );
  err.status = 403;
  throw err;
}

export function signin({ email, password }) {
  const user = db.findUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    throw err;
  }
  // Keep owner role sticky for the designated owner email.
  if (resolveRole(user) === 'owner' && user.role !== 'owner') {
    db.updateUser(user.id, { role: 'owner' });
  }
  const session = issueSession(user.id);
  return { user: publicUser(db.findUserById(user.id)), token: session.token, expiresAt: session.expiresAt };
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

export function requireOwner(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (!user.isOwner) {
    res.status(403).json({ error: 'Owner access required' });
    return null;
  }
  return user;
}

function validateMemberInput({ email, password, name, requirePassword }) {
  const e = String(email || '').trim().toLowerCase();
  const p = password === undefined || password === null ? '' : String(password);
  const n = String(name || '').trim();
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    const err = new Error('Valid email is required');
    err.status = 400;
    throw err;
  }
  if (requirePassword || p) {
    if (p.length < 6) {
      const err = new Error('Password must be at least 6 characters');
      err.status = 400;
      throw err;
    }
  }
  return { email: e, password: p, name: n || e.split('@')[0] };
}

export function createMember({ email, password, name }) {
  const input = validateMemberInput({ email, password, name, requirePassword: true });
  if (input.email === getOwnerEmail()) {
    const err = new Error('Cannot create another account for the owner email');
    err.status = 400;
    throw err;
  }
  if (db.findUserByEmail(input.email)) {
    const err = new Error('An account with this email already exists');
    err.status = 409;
    throw err;
  }
  const user = db.createUser({
    id: uuidv4(),
    email: input.email,
    passwordHash: hashPassword(input.password),
    name: input.name,
    role: 'member',
  });
  db.saveProfile(user.id, structuredClone(EMPTY_PROFILE));
  return publicUser(user);
}

export function updateMember(id, { email, password, name }) {
  const existing = db.findUserById(id);
  if (!existing) {
    const err = new Error('Member not found');
    err.status = 404;
    throw err;
  }

  const nextPassword = password === undefined || password === null ? '' : String(password);
  if (nextPassword) {
    if (nextPassword.length < 6) {
      const err = new Error('Password must be at least 6 characters');
      err.status = 400;
      throw err;
    }
  }

  if (resolveRole(existing) === 'owner') {
    // Owner account: allow name/password update, not email/role demotion via this path.
    const patch = { role: 'owner' };
    if (name !== undefined) patch.name = String(name || '').trim() || existing.name;
    if (nextPassword) patch.passwordHash = hashPassword(nextPassword);
    const updated = db.updateUser(id, patch);
    return publicUser(updated);
  }

  const input = validateMemberInput({
    email: email !== undefined ? email : existing.email,
    password: nextPassword,
    name: name !== undefined ? name : existing.name,
    requirePassword: false,
  });
  if (input.email === getOwnerEmail()) {
    const err = new Error('Cannot assign the owner email to a member');
    err.status = 400;
    throw err;
  }
  const conflict = db.findUserByEmail(input.email);
  if (conflict && conflict.id !== id) {
    const err = new Error('An account with this email already exists');
    err.status = 409;
    throw err;
  }
  const patch = {
    email: input.email,
    name: input.name,
    role: 'member',
  };
  if (nextPassword) patch.passwordHash = hashPassword(nextPassword);
  const updated = db.updateUser(id, patch);
  return publicUser(updated);
}

export function deleteMember(id) {
  const existing = db.findUserById(id);
  if (!existing) {
    const err = new Error('Member not found');
    err.status = 404;
    throw err;
  }
  if (resolveRole(existing) === 'owner') {
    const err = new Error('Cannot remove the owner account');
    err.status = 400;
    throw err;
  }
  db.deleteUser(id);
  return true;
}

export function listMembers() {
  return db.listUsers().map(publicUser);
}

/**
 * Ensure a known admin/owner account exists (email/password from env).
 */
export function ensureAdminUserFromEnv() {
  const email = String(process.env.ADMIN_EMAIL || getOwnerEmail())
    .trim()
    .toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  const name = String(process.env.ADMIN_NAME || '').trim() || 'Owner';
  if (!email) return null;

  const existing = db.findUserByEmail(email);
  if (existing) {
    const patch = { role: 'owner' };
    if (name) patch.name = name;
    if (password && !verifyPassword(password, existing.passwordHash)) {
      patch.passwordHash = hashPassword(password);
    }
    db.updateUser(existing.id, patch);
    return publicUser(db.findUserById(existing.id));
  }

  if (!password) return null;

  const user = db.createUser({
    id: uuidv4(),
    email,
    passwordHash: hashPassword(password),
    name,
    role: 'owner',
  });
  db.saveProfile(user.id, structuredClone(EMPTY_PROFILE));
  return publicUser(user);
}
