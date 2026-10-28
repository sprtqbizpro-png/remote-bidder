import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jobsRouter from './routes/jobs.js';
import answersRouter from './routes/answers.js';
import resumeRouter from './routes/resume.js';
import authRouter from './routes/auth.js';
import extractRouter from './routes/extract.js';
import profileRouter from './routes/profile.js';
import db from './db.js';
import { consolidateFixedAnswerRows } from './fixedAnswers.js';

const app = express();
const PORT = process.env.PORT || 3847;

/** One-time (idempotent) collapse of legacy phrasing duplicates into intent rows. */
function migrateFixedAnswersOnStartup() {
  try {
    const before = db.listFixedAnswers();
    const { rows, changed } = consolidateFixedAnswerRows(before);
    if (changed) {
      db.replaceFixedAnswers(rows);
      console.log(
        `Fixed answers consolidated: ${before.length} → ${rows.length} (meaning-based intents)`
      );
    }
  } catch (err) {
    console.warn('Fixed-answer consolidate on startup failed:', err?.message || err);
  }
}

migrateFixedAnswersOnStartup();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'King Star API' });
});

app.use('/api/jobs', jobsRouter);
app.use('/api/answers', answersRouter);
app.use('/api/resume', resumeRouter);
app.use('/api/auth', authRouter);
app.use('/api/profile', profileRouter);
app.use('/api/extract', extractRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`King Star API listening on http://localhost:${PORT}`);
});
