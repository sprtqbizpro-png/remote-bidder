import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { uploadResume, isDriveConnected } from '../googleDrive.js';
import { resumeTextFromDataUrl, parseResumeHistory } from '../resumeHistory.js';
import { getStoredOpenAIKey } from './auth.js';

function resolveUploadDir() {
  const preferred = path.join(process.cwd(), 'data', 'uploads');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const probe = path.join(preferred, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), 'king-star-uploads');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

const uploadDir = resolveUploadDir();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /pdf|msword|officedocument|text|rtf/i.test(file.mimetype) ||
      /\.(pdf|doc|docx|txt|rtf)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only resume documents are allowed'), ok);
  },
});

const router = Router();

/** Upload resume → Google Drive, return shareable link */
router.post('/upload', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'resume file is required (field name: resume)' });
    }
    if (!isDriveConnected()) {
      return res.status(400).json({
        error: 'Google Drive not connected. Open King Star web app and connect Google Drive first.',
      });
    }

    const company = (req.body.companyName || 'Unknown').replace(/[^\w\s-]/g, '').trim() || 'Unknown';
    const role = (req.body.roleName || 'Role').replace(/[^\w\s-]/g, '').trim() || 'Role';
    const ext = path.extname(req.file.originalname) || '.pdf';
    const driveName = `${company} - ${role} - Resume${ext}`;

    // Prefer real mime from extension when browser sends empty/octet-stream (common for .docx)
    let mimeType = req.file.mimetype || 'application/octet-stream';
    if (!mimeType || mimeType === 'application/octet-stream') {
      const lower = String(req.file.originalname || '').toLowerCase();
      if (lower.endsWith('.pdf')) mimeType = 'application/pdf';
      else if (lower.endsWith('.docx')) {
        mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } else if (lower.endsWith('.doc')) mimeType = 'application/msword';
      else if (lower.endsWith('.txt')) mimeType = 'text/plain';
      else if (lower.endsWith('.rtf')) mimeType = 'application/rtf';
    }

    const result = await uploadResume(req.file.path, driveName, mimeType);

    // Clean local temp file
    try {
      fs.unlinkSync(req.file.path);
    } catch {
      /* ignore */
    }

    res.json({
      fileId: result.fileId,
      webViewLink: result.webViewLink,
      webContentLink: result.webContentLink,
      name: result.name,
    });
  } catch (err) {
    console.error('resume upload error:', err);
    if (req.file?.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
    }
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

/**
 * POST /api/resume/history
 * Body: { resumeText?, resumeDataUrl?, resumeName?, apiKey? }
 * Returns the resume's plain text plus structured work / education history for form autofill.
 */
router.post('/history', async (req, res) => {
  try {
    const { resumeText, resumeDataUrl, resumeName, apiKey } = req.body || {};
    let text = String(resumeText || '').trim();
    if (text.length < 40 && resumeDataUrl) {
      text = await resumeTextFromDataUrl(resumeDataUrl, resumeName);
    }
    if (text.length < 40) {
      return res.status(422).json({ error: 'Could not read text from the resume (scanned image PDF?)' });
    }
    const key = apiKey || getStoredOpenAIKey();
    if (!key) return res.status(400).json({ error: 'OpenAI API key not configured', text });
    const history = await parseResumeHistory({ text, apiKey: key });
    res.json({ text, ...history });
  } catch (err) {
    console.error('resume history error:', err);
    res.status(500).json({ error: err.message || 'Resume analysis failed' });
  }
});

router.get('/status', (_req, res) => {
  res.json({ connected: isDriveConnected() });
});

export default router;
