import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { structureJobDescription } from '../cleanDescription.js';
import {
  isDriveConnected,
  uploadJobInfoText,
  formatJobInfoText,
} from '../googleDrive.js';

const router = Router();

function mapJob(row) {
  if (!row) return null;
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
  };
}

function safeFilePart(s, fallback) {
  return String(s || fallback || 'item')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

router.get('/', (_req, res) => {
  res.json(db.listJobs().map(mapJob));
});

router.get('/:id', (req, res) => {
  const job = mapJob(db.getJob(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

/**
 * Save applied job for the web app.
 * Also uploads a review .txt (title, company, description) to Google Drive when connected.
 */
router.post('/', async (req, res) => {
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
  });

  const mapped = mapJob(row);
  if (driveWarning) mapped.driveWarning = driveWarning;
  if (!isDriveConnected()) {
    mapped.driveWarning =
      mapped.driveWarning ||
      'Google Drive not connected — job saved locally; connect Drive to sync resume & job info files.';
  }

  res.status(201).json(mapped);
});

router.delete('/:id', (req, res) => {
  if (!db.deleteJob(req.params.id)) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({ ok: true });
});

export default router;
