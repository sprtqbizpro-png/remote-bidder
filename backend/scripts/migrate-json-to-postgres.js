/**
 * Push local backend/data/hidden-star.json into Postgres (DATABASE_URL).
 *
 * Usage (from backend/):
 *   set DATABASE_URL=postgres://...   # Windows PowerShell: $env:DATABASE_URL="..."
 *   npm run db:migrate
 *
 * This preserves jobs, fixed answers, users, profiles, settings, and Google tokens.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, flushDb, db } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonPath = path.join(__dirname, '..', 'data', 'hidden-star.json');

async function main() {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL (or POSTGRES_URL) is required.');
    process.exit(1);
  }
  if (!fs.existsSync(jsonPath)) {
    console.error(`Local DB file not found: ${jsonPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  console.log('Local snapshot:', {
    jobs: raw.applied_jobs?.length || 0,
    answers: raw.fixed_answers?.length || 0,
    users: raw.users?.length || 0,
    profiles: Object.keys(raw.profiles || {}).length,
    hasGoogle: !!raw.google_tokens,
  });

  await initDb();
  db.replaceAll(raw);
  await flushDb();

  const after = db.snapshot();
  console.log('Postgres store updated:', {
    jobs: after.applied_jobs?.length || 0,
    answers: after.fixed_answers?.length || 0,
    users: after.users?.length || 0,
  });
  console.log('Done. Redeploy or refresh the Vercel app.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
