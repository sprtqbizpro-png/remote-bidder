import { Router } from 'express';
import { extractJobFromPage } from '../openai.js';
import { getStoredOpenAIKey } from './auth.js';
import { structureJobDescription } from '../cleanDescription.js';

const router = Router();

/** Simple in-memory cache by content hash (reduces repeat OpenAI calls) */
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 100;

function hashKey(pageUrl, pageText) {
  const base = `${pageUrl || ''}|${String(pageText || '').slice(0, 2000)}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return String(h);
}

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function setCached(key, data) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, { at: Date.now(), data });
}

/**
 * POST /api/extract
 * Body: { pageText, pageUrl, title, hints?, apiKey? }
 */
router.post('/', async (req, res) => {
  try {
    const { pageText, pageUrl, title, hints, apiKey } = req.body || {};
    if (!pageText || String(pageText).trim().length < 40) {
      return res.status(400).json({
        error: 'pageText is required (cleaned job page text, min ~40 chars)',
      });
    }

    const key = hashKey(pageUrl, pageText);
    const cached = getCached(key);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const result = await extractJobFromPage({
      pageText,
      pageUrl,
      title,
      hints,
      apiKey: apiKey || getStoredOpenAIKey(),
    });

    result.jobDescription = structureJobDescription(result.jobDescription);

    if (!result.companyName || !result.roleName || !result.jobDescription) {
      return res.status(422).json({
        error: 'Could not extract complete job fields',
        result,
      });
    }

    setCached(key, result);
    res.json({ ...result, cached: false });
  } catch (err) {
    console.error('extract error:', err);
    res.status(500).json({ error: err.message || 'Extraction failed' });
  }
});

export default router;
