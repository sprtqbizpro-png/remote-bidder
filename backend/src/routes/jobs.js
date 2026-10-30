import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db, { flushDb } from '../db.js';
import { structureJobDescription } from '../cleanDescription.js';
import {
  isDriveConnected,
  uploadJobInfoText,
  formatJobInfoText,
} from '../googleDrive.js';
import { getBearerToken, requireOwner, requireUser, userFromToken } from '../userAuth.js';

const router = Router();

function mapJob(row) {
  if (!row) return null;
  const creator = row.created_by_user_id ? db.findUserById(row.created_by_user_id) : null;
  return {
    id: row.id,
    companyName: row.company_name,
    roleName: row.role_name,
    jobDescription: row.job_description,
    resumeDriveLink: row.resume_drive_link,
    resumeDriveFileId: row.resume_drive_file_id,
    jobInfoDriveLink: row.job_info_drive_link || null,
    jobInfoDriveFileId: row.job_info_drive_file_id || null,
    sourceUrl: row.source_url,
    appliedAt: row.applied_at,
    createdBy: {
      userId: row.created_by_user_id || null,
      email: row.created_by_email || creator?.email || null,
      name: row.created_by_name || creator?.name || null,
    },
  };
}

function safeFilePart(s, fallback) {
  return String(s || fallback || 'item')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

router.get('/', (req, res) => {
  // Prefer authenticated access; still allow list if signed in via optional token.
  const user = userFromToken(getBearerToken(req));
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  res.json(db.listJobs().map(mapJob));
});

router.get('/:id', (req, res) => {
  const user = userFromToken(getBearerToken(req));
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  const job = mapJob(db.getJob(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

/**
 * Save applied job for the web app.
 * Also uploads a review .txt (title, company, description) to Google Drive when connected.
 */
router.post('/', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const {
    companyName,
    roleName,
    jobDescription,
    resumeDriveLink,
    resumeDriveFileId,
    sourceUrl,
  } = req.body || {};

  if (!companyName || !roleName || !jobDescription) {
    return res.status(400).json({
      error: 'companyName, roleName, and jobDescription are required',
    });
  }

  const structured = structureJobDescription(jobDescription);
  const id = uuidv4();
  const appliedAt = new Date().toISOString();

  let jobInfoDriveLink = null;
  let jobInfoDriveFileId = null;
  let driveWarning = null;

  if (isDriveConnected()) {
    try {
      const fileName = `${safeFilePart(companyName, 'Company')} - ${safeFilePart(roleName, 'Role')} - Job Info.txt`;
      const text = formatJobInfoText({
        companyName,
        roleName,
        jobDescription: structured,
        sourceUrl,
        appliedAt,
      });
      const uploaded = await uploadJobInfoText(fileName, text);
      jobInfoDriveLink = uploaded.webViewLink || null;
      jobInfoDriveFileId = uploaded.fileId || null;
    } catch (err) {
      console.warn('Job info Drive upload failed:', err.message);
      driveWarning = err.message || 'Could not upload job info text to Drive';
    }
  }

  const row = db.insertJob({
    id,
    company_name: companyName,
    role_name: roleName,
    job_description: structured,
    resume_drive_link: resumeDriveLink || null,
    resume_drive_file_id: resumeDriveFileId || null,
    job_info_drive_link: jobInfoDriveLink,
    job_info_drive_file_id: jobInfoDriveFileId,
    source_url: sourceUrl || null,
    applied_at: appliedAt,
    created_by_user_id: user.id,
    created_by_email: user.email,
    created_by_name: user.name || user.email,
  });

  // Persist before responding so other serverless instances (and the web list) see it.
  await flushDb();

  const mapped = mapJob(row);
  if (driveWarning) mapped.driveWarning = driveWarning;
  if (!isDriveConnected()) {
    mapped.driveWarning =
      mapped.driveWarning ||
      'Google Drive not connected — job saved locally; connect Drive to sync resume & job info files.';
  }

  res.status(201).json(mapped);
});

/** Any signed-in member can correct a saved job's title / company. */
router.patch('/:id', async (req, res) => {
  if (!requireUser(req, res)) return;
  const { companyName, roleName } = req.body || {};
  const patch = {};
  if (companyName != null) {
    const v = String(companyName).trim();
    if (!v) return res.status(400).json({ error: 'Company cannot be empty' });
    patch.company_name = v.slice(0, 200);
  }
  if (roleName != null) {
    const v = String(roleName).trim();
    if (!v) return res.status(400).json({ error: 'Job title cannot be empty' });
    patch.role_name = v.slice(0, 200);
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'companyName or roleName is required' });
  }
  const row = db.updateJob(req.params.id, patch);
  if (!row) return res.status(404).json({ error: 'Job not found' });
  await flushDb();
  res.json(mapJob(row));
});

router.delete('/:id', async (req, res) => {
  // Only the owner can remove applied jobs; members can view the shared list.
  if (!requireOwner(req, res)) return;
  if (!db.deleteJob(req.params.id)) {
    return res.status(404).json({ error: 'Job not found' });
  }
  await flushDb();
  res.json({ ok: true });
});

export default router;
