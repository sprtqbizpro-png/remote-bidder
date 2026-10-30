import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { neon } from '@neondatabase/serverless';
import { detectQuestionIntent } from './fixedAnswers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_ID = 'default';

const DEFAULT = {
  applied_jobs: [],
  fixed_answers: [],
  settings: {},
  google_tokens: null,
  users: [],
  sessions: [],
  profiles: {},
  /** { [collection]: { [id]: deletedAtMs } } — see "Deletions" below */
  tombstones: {},
};

/*
 * Deletions. Saves and per-request reloads merge this instance's data with the stored copy
 * (so rows created on another serverless instance are not lost). A plain union also brought
 * back every row deleted here — single Delete, "Clear all", job Remove, sign-out, duplicate
 * cleanup. Deleted ids are therefore recorded as tombstones, stored with the data, and the
 * merge drops tombstoned rows. Tombstones expire after 30 days.
 */
const TRACKED = { applied_jobs: 'id', fixed_answers: 'id', users: 'id', sessions: 'token' };
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
/** Ids per collection as of the last load / save: the baseline for spotting local deletes. */
let syncedIds = null;

function idsOf(store) {
  const out = {};
  for (const [coll, key] of Object.entries(TRACKED)) {
    out[coll] = new Set((store?.[coll] || []).map((r) => r?.[key]).filter((v) => v != null));
  }
  return out;
}

/** Tombstone ids that were in the baseline but are gone from the in-memory store. */
function recordDeletions(store) {
  store.tombstones = store.tombstones || {};
  if (!syncedIds) return;
  const now = Date.now();
  const present = idsOf(store);
  for (const coll of Object.keys(TRACKED)) {
    const tomb = (store.tombstones[coll] = store.tombstones[coll] || {});
    for (const id of syncedIds[coll] || []) {
      if (!present[coll].has(id)) tomb[id] = now;
    }
    // Re-created with the same id: alive again
    for (const id of present[coll]) {
      if (tomb[id] && !(syncedIds[coll] || new Set()).has(id)) delete tomb[id];
    }
  }
}

function mergeTombstones(a = {}, b = {}) {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const out = {};
  for (const coll of Object.keys(TRACKED)) {
    const merged = {};
    for (const src of [a?.[coll] || {}, b?.[coll] || {}]) {
      for (const [id, at] of Object.entries(src)) {
        if (at >= cutoff) merged[id] = Math.max(merged[id] || 0, at);
      }
    }
    out[coll] = merged;
  }
  return out;
}

function withoutTombstoned(list, coll, tombstones) {
  const tomb = tombstones?.[coll] || {};
  const key = TRACKED[coll];
  return (list || []).filter((r) => !tomb[r?.[key]]);
}

/** @type {ReturnType<typeof structuredClone>|null} */
let state = null;
/** @type {Promise<void>|null} */
let readyPromise = null;
/** @type {((data: object) => Promise<void>)|null} */
let persistFn = null;
/** @type {(() => Promise<object>)|null} */
let loadFn = null;
/** Like loadFn, but resolves null when the stored copy has not changed since we last saw it. */
let loadChangedFn = null;
let writeQueue = Promise.resolve();
/** @type {Promise<void>|null} */
let reloadPromise = null;

function isFsReadonlyError(err) {
  return ['EACCES', 'EPERM', 'EROFS', 'ENOENT'].includes(err?.code);
}

function tryWritableDbPath(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  return path.join(dir, 'hidden-star.json');
}

function resolveFileDbPath() {
  if (process.env.DATA_DIR) {
    return tryWritableDbPath(path.resolve(process.env.DATA_DIR));
  }

  const candidates = [
    path.join(__dirname, '..', 'data'),
    path.join(process.cwd(), 'data'),
  ];

  let lastErr = null;
  for (const dir of candidates) {
    try {
      return tryWritableDbPath(dir);
    } catch (err) {
      lastErr = err;
    }
  }

  if (lastErr && !isFsReadonlyError(lastErr)) {
    console.warn('[db] Unexpected data-dir error:', lastErr.message);
  }

  const fallbackDir = path.join(os.tmpdir(), 'king-star-data');
  console.warn(
    `[db] Package data dir not writable (${lastErr?.code || lastErr?.message}); using ${fallbackDir}. Set DATABASE_URL for durable storage on Vercel.`
  );
  return tryWritableDbPath(fallbackDir);
}

function createFilePersist(dbPath) {
  return {
    async load() {
      try {
        if (!fs.existsSync(dbPath)) {
          fs.writeFileSync(dbPath, JSON.stringify(DEFAULT, null, 2), 'utf8');
          return structuredClone(DEFAULT);
        }
        const raw = fs.readFileSync(dbPath, 'utf8');
        return { ...structuredClone(DEFAULT), ...JSON.parse(raw) };
      } catch {
        return structuredClone(DEFAULT);
      }
    },
    async save(data) {
      fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
    },
  };
}

function createPostgresPersist(databaseUrl) {
  const sql = neon(databaseUrl);
  /** updated_at (as text, full precision) of the copy this instance last read or wrote. */
  let stamp = null;
  return {
    /**
     * Full blob only when another instance saved since our last read/write; otherwise a
     * timestamp-sized reply. Reading the whole store on every request is what used up the
     * Neon data-transfer / compute quota.
     */
    async loadIfChanged() {
      if (!stamp) return this.load();
      const rows = await sql`
        SELECT data, updated_at::text AS stamp FROM king_star_store
        WHERE id = ${STORE_ID} AND updated_at > ${stamp}::timestamptz
        LIMIT 1
      `;
      if (!rows.length) return null;
      stamp = rows[0].stamp;
      return { ...structuredClone(DEFAULT), ...rows[0].data };
    },
    async load() {
      await sql`
        CREATE TABLE IF NOT EXISTS king_star_store (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      const rows = await sql`
        SELECT data, updated_at::text AS stamp FROM king_star_store WHERE id = ${STORE_ID} LIMIT 1
      `;
      if (!rows.length) {
        const seed = structuredClone(DEFAULT);
        await sql`
          INSERT INTO king_star_store (id, data)
          VALUES (${STORE_ID}, ${seed})
          ON CONFLICT (id) DO NOTHING
        `;
        return seed;
      }
      stamp = rows[0].stamp;
      return { ...structuredClone(DEFAULT), ...rows[0].data };
    },
    async save(data) {
      const rows = await sql`
        INSERT INTO king_star_store (id, data, updated_at)
        VALUES (${STORE_ID}, ${data}, NOW())
        ON CONFLICT (id) DO UPDATE
        SET data = EXCLUDED.data, updated_at = NOW()
        RETURNING updated_at::text AS stamp
      `;
      if (rows?.[0]?.stamp) stamp = rows[0].stamp;
    },
  };
}

function ensureReady() {
  if (!state) {
    throw new Error('Database not initialized. Call await initDb() before handling requests.');
  }
}

function read() {
  ensureReady();
  return state;
}

function mergeById(localList, remoteList, idKey = 'id') {
  const map = new Map();
  for (const row of remoteList || []) {
    if (row?.[idKey] != null) map.set(row[idKey], row);
  }
  for (const row of localList || []) {
    if (row?.[idKey] == null) continue;
    const prev = map.get(row[idKey]);
    // Prefer the locally mutated row when both exist (this request's write).
    map.set(row[idKey], prev ? { ...prev, ...row } : row);
  }
  return [...map.values()];
}

function mergeStoreBlobs(local, remote) {
  const baseRemote = { ...structuredClone(DEFAULT), ...(remote || {}) };
  const baseLocal = { ...structuredClone(DEFAULT), ...(local || {}) };
  const tombstones = mergeTombstones(baseLocal.tombstones, baseRemote.tombstones);
  const live = (coll, list) => withoutTombstoned(list, coll, tombstones);

  const sessions = live(
    'sessions',
    mergeById(
      (baseLocal.sessions || []).filter((s) => s?.token && s.expiresAt > Date.now()),
      (baseRemote.sessions || []).filter((s) => s?.token && s.expiresAt > Date.now()),
      'token'
    )
  );

  const applied_jobs = live(
    'applied_jobs',
    mergeById(baseLocal.applied_jobs, baseRemote.applied_jobs, 'id')
  ).sort((a, b) => String(b.applied_at || '').localeCompare(String(a.applied_at || '')));

  const users = live('users', mergeById(baseLocal.users, baseRemote.users, 'id'));
  const fixed_answers = live(
    'fixed_answers',
    mergeById(baseLocal.fixed_answers, baseRemote.fixed_answers, 'id')
  );

  const profiles = {
    ...(baseRemote.profiles || {}),
    ...(baseLocal.profiles || {}),
  };

  // Prefer local settings / google tokens when this request changed them;
  // otherwise keep remote so we don't wipe Drive tokens from another instance.
  const settings = {
    ...(baseRemote.settings || {}),
    ...(baseLocal.settings || {}),
  };
  const google_tokens = baseLocal.google_tokens ?? baseRemote.google_tokens ?? null;

  return {
    applied_jobs,
    fixed_answers,
    settings,
    google_tokens,
    users,
    sessions,
    profiles,
    tombstones,
  };
}

async function persistMerged(snapshot) {
  if (!persistFn) return;
  let toSave = structuredClone(snapshot);
  if (loadFn) {
    try {
      // Unchanged since we last read/wrote: our snapshot already holds everything
      const remote = await (loadChangedFn || loadFn)();
      if (remote) toSave = mergeStoreBlobs(toSave, remote);
      // Keep in-memory store aligned with what we persist.
      if (remote && state) {
        state.sessions = toSave.sessions;
        state.applied_jobs = toSave.applied_jobs;
        state.users = toSave.users;
        state.fixed_answers = toSave.fixed_answers;
        state.profiles = toSave.profiles;
        state.settings = toSave.settings;
        state.tombstones = toSave.tombstones;
        if (toSave.google_tokens) state.google_tokens = toSave.google_tokens;
        syncedIds = idsOf(state);
      }
    } catch (err) {
      console.warn('[db] merge before save skipped:', err?.message || err);
    }
  }
  await persistFn(toSave);
}

function write(data) {
  ensureReady();
  state = data;
  recordDeletions(state);
  syncedIds = idsOf(state);
  if (!persistFn) return;
  const snapshot = structuredClone(state);
  writeQueue = writeQueue
    .then(() => persistMerged(snapshot))
    .catch((err) => {
      console.error('[db] persist failed:', err?.message || err);
    });
}

function nowIso() {
  return new Date().toISOString();
}

const MAX_ALIASES = 25;

function mergeAliases(existing, added) {
  const out = Array.isArray(existing) ? existing.filter(Boolean) : [];
  for (const a of added || []) {
    if (a && !out.includes(a)) out.push(a);
  }
  return out.slice(-MAX_ALIASES);
}

/**
 * Merge durable store with in-memory mutations so jobs/sessions created
 * on this instance are not lost when reloading another instance's blob.
 */
function mergeLoadedState(local, remote) {
  return mergeStoreBlobs(local, remote);
}

/**
 * Initialize in-memory store and persistence backend.
 * Uses Postgres when DATABASE_URL is set (Vercel); otherwise local JSON file.
 * Safe to call on every request — concurrent callers share one load promise.
 */
export async function initDb() {
  if (state) return;
  if (readyPromise) {
    try {
      await readyPromise;
      if (state) return;
    } catch {
      // Allow retry after a failed cold-start init.
      readyPromise = null;
    }
  }
  readyPromise = (async () => {
    const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    const backend = databaseUrl
      ? createPostgresPersist(databaseUrl)
      : createFilePersist(resolveFileDbPath());
    persistFn = (data) => backend.save(data);
    loadFn = () => backend.load();
    loadChangedFn = backend.loadIfChanged ? () => backend.loadIfChanged() : loadFn;
    state = await backend.load();
    state.tombstones = state.tombstones || {};
    syncedIds = idsOf(state);
    console.log(
      databaseUrl
        ? '[db] Using Postgres (DATABASE_URL)'
        : '[db] Using local JSON file store'
    );
  })();
  try {
    await readyPromise;
  } catch (err) {
    readyPromise = null;
    throw err;
  }
}

/** Wait for any queued persist operations (useful for migrate scripts). */
export async function flushDb() {
  await writeQueue;
}

/**
 * Re-read durable store (Postgres/file) so serverless instances see
 * sessions created on another instance. Call once per request.
 */
export async function reloadDb() {
  await initDb();
  await flushDb();
  if (!loadFn) return state;
  if (reloadPromise) {
    await reloadPromise;
    return state;
  }
  reloadPromise = (async () => {
    const fresh = await (loadChangedFn || loadFn)();
    if (fresh) {
      state = mergeLoadedState(state, fresh);
      syncedIds = idsOf(state);
    }
  })();
  try {
    await reloadPromise;
  } finally {
    reloadPromise = null;
  }
  return state;
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

  /** Patch an applied job's editable fields (company / role). */
  updateJob(id, patch = {}) {
    const data = read();
    const job = data.applied_jobs.find((j) => j.id === id);
    if (!job) return null;
    for (const k of ['company_name', 'role_name']) {
      if (patch[k] != null) job[k] = String(patch[k]);
    }
    job.updated_at = nowIso();
    write(data);
    return job;
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

  upsertFixedAnswer({ id, question_key, question_pattern, answer, intent = null, aliases = [] }) {
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
      // Exact live phrasings seen for this answer (normalized) — reused without an LLM call
      aliases: mergeAliases(prev?.aliases, aliases),
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

  /** Update an existing fixed answer's value and/or record another phrasing for it. */
  updateFixedAnswer(id, { answer, alias, question_pattern } = {}) {
    const data = read();
    const row = data.fixed_answers.find((a) => a.id === id);
    if (!row) return null;
    const aliases = mergeAliases(row.aliases, alias ? [alias] : []);
    const nextAnswer = answer != null ? String(answer) : row.answer;
    const nextPattern = question_pattern != null ? String(question_pattern) : row.question_pattern;
    if (
      nextAnswer === row.answer &&
      nextPattern === row.question_pattern &&
      aliases.length === (row.aliases || []).length
    ) {
      return row;
    }
    row.answer = nextAnswer;
    row.question_pattern = nextPattern;
    row.aliases = aliases;
    row.updated_at = nowIso();
    write(data);
    return row;
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

  listUsers() {
    return read()
      .users.slice()
      .sort((a, b) => String(a.email).localeCompare(String(b.email)));
  },

  createUser({ id, email, passwordHash, name, role = 'member' }) {
    const data = read();
    const row = {
      id,
      email: String(email).trim().toLowerCase(),
      passwordHash,
      name: String(name || '').trim(),
      role: role === 'owner' ? 'owner' : 'member',
      created_at: nowIso(),
    };
    data.users.push(row);
    write(data);
    return row;
  },

  updateUser(id, patch) {
    const data = read();
    const idx = data.users.findIndex((u) => u.id === id);
    if (idx < 0) return null;
    const next = { ...data.users[idx], ...patch };
    if (patch.email !== undefined) next.email = String(patch.email).trim().toLowerCase();
    if (patch.name !== undefined) next.name = String(patch.name || '').trim();
    if (patch.role !== undefined) next.role = patch.role === 'owner' ? 'owner' : 'member';
    data.users[idx] = next;
    write(data);
    return next;
  },

  deleteUser(id) {
    const data = read();
    const before = data.users.length;
    data.users = data.users.filter((u) => u.id !== id);
    data.sessions = data.sessions.filter((s) => s.userId !== id);
    if (data.profiles?.[id]) delete data.profiles[id];
    write(data);
    return before !== data.users.length;
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

  /** Replace entire store (used by migrate script). */
  replaceAll(next) {
    write({ ...structuredClone(DEFAULT), ...next });
  },

  snapshot() {
    return structuredClone(read());
  },
};

export default db;
