import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { detectQuestionIntent } from './fixedAnswers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const DB_PATH = path.join(dataDir, 'hidden-star.json');

const DEFAULT = {
  applied_jobs: [],
  fixed_answers: [],
  settings: {},
  google_tokens: null,
  users: [],
  sessions: [],
  profiles: {},
};

function read() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      write(DEFAULT);
      return structuredClone(DEFAULT);
    }
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return { ...structuredClone(DEFAULT), ...JSON.parse(raw) };
  } catch {
    return structuredClone(DEFAULT);
  }
}

function write(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

export const db = {
  listJobs() {
    return read()
      .applied_jobs.slice()
      .sort((a, b) => String(b.applied_at).localeCompare(String(a.applied_at)));
  },

  getJob(id) {
    return read().applied_jobs.find((j) => j.id === id) || null;
  },

  insertJob(job) {
    const data = read();
    const row = {
      ...job,
      applied_at: job.applied_at || nowIso(),
    };
    data.applied_jobs.unshift(row);
    write(data);
    return row;
  },

  updateJob(id, patch) {
    const data = read();
    const idx = data.applied_jobs.findIndex((j) => j.id === id);
    if (idx < 0) return null;
    data.applied_jobs[idx] = { ...data.applied_jobs[idx], ...patch };
    write(data);
    return data.applied_jobs[idx];
  },

  deleteJob(id) {
    const data = read();
    const before = data.applied_jobs.length;
    data.applied_jobs = data.applied_jobs.filter((j) => j.id !== id);
    write(data);
    return before !== data.applied_jobs.length;
  },

  listFixedAnswers() {
    return read()
      .fixed_answers.slice()
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  },

  replaceFixedAnswers(rows) {
    const data = read();
    data.fixed_answers = Array.isArray(rows) ? rows : [];
    write(data);
    return data.fixed_answers;
  },

  upsertFixedAnswer({ id, question_key, question_pattern, answer, intent = null }) {
    const data = read();
    const intentKey = intent ? `intent_${intent}` : null;
    const sameIntent = (a) => {
      if (!intent) return false;
      if (a.intent === intent || a.question_key === intentKey) return true;
      const detected = detectQuestionIntent(a.question_pattern || '');
      return detected === intent;
    };
    let prev =
      data.fixed_answers.find((a) => a.question_key === question_key) ||
      (intent ? data.fixed_answers.find(sameIntent) : null);

    const row = {
      id: prev?.id || id,
      question_key: intent ? intentKey : question_key,
      question_pattern,
      answer,
      intent: intent || prev?.intent || null,
      updated_at: nowIso(),
    };

    data.fixed_answers = data.fixed_answers.filter((a) => {
      if (a.id === row.id) return false;
      if (sameIntent(a)) return false;
      if (!intent && a.question_key === question_key) return false;
      return true;
    });
    data.fixed_answers.push(row);
    write(data);
    return { row, created: !prev };
  },

  getFixedByKey(key) {
    return read().fixed_answers.find((a) => a.question_key === key) || null;
  },

  getFixedByIntent(intent) {
    if (!intent) return null;
    return (
      read().fixed_answers.find(
        (a) => a.intent === intent || a.question_key === `intent_${intent}`
      ) || null
    );
  },

  deleteFixedAnswer(id) {
    const data = read();
    const before = data.fixed_answers.length;
    data.fixed_answers = data.fixed_answers.filter((a) => a.id !== id);
    write(data);
    return before !== data.fixed_answers.length;
  },

  getSetting(key) {
    return read().settings[key] ?? null;
  },

  setSetting(key, value) {
    const data = read();
    data.settings[key] = value;
    write(data);
  },

  getAllSettings() {
    return { ...read().settings };
  },

  getGoogleTokens() {
    return read().google_tokens;
  },

  saveGoogleTokens(tokens) {
    const data = read();
    const existing = data.google_tokens || {};
    data.google_tokens = {
      access_token: tokens.access_token || existing.access_token || null,
      refresh_token: tokens.refresh_token || existing.refresh_token || null,
      expiry_date: tokens.expiry_date || existing.expiry_date || null,
      updated_at: nowIso(),
    };
    write(data);
  },

  clearGoogleTokens() {
    const data = read();
    data.google_tokens = null;
    write(data);
  },

  findUserByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return read().users.find((u) => u.email === e) || null;
  },

  findUserById(id) {
    return read().users.find((u) => u.id === id) || null;
  },

  createUser({ id, email, passwordHash, name }) {
    const data = read();
    const row = {
      id,
      email: String(email).trim().toLowerCase(),
      passwordHash,
      name: String(name || '').trim(),
      created_at: nowIso(),
    };
    data.users.push(row);
    write(data);
    return { id: row.id, email: row.email, name: row.name, created_at: row.created_at };
  },

  createSession({ token, userId, expiresAt }) {
    const data = read();
    data.sessions = data.sessions.filter((s) => s.expiresAt > Date.now());
    data.sessions.push({ token, userId, expiresAt });
    write(data);
    return { token, userId, expiresAt };
  },

  getSession(token) {
    if (!token) return null;
    const data = read();
    const session = data.sessions.find((s) => s.token === token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      data.sessions = data.sessions.filter((s) => s.token !== token);
      write(data);
      return null;
    }
    return session;
  },

  deleteSession(token) {
    const data = read();
    data.sessions = data.sessions.filter((s) => s.token !== token);
    write(data);
  },

  getProfile(userId) {
    return read().profiles[userId] || null;
  },

  getAllProfiles() {
    return { ...read().profiles };
  },

  saveProfile(userId, profile) {
    const data = read();
    data.profiles[userId] = {
      ...profile,
      updated_at: nowIso(),
    };
    write(data);
    return data.profiles[userId];
  },
};

export default db;
