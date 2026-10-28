import { google } from 'googleapis';
import db from './db.js';
import fs from 'fs';
import { Readable } from 'stream';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    'http://localhost:3847/api/auth/google/callback';

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getAuthUrl() {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

export function loadTokens() {
  return db.getGoogleTokens();
}

export function saveTokens(tokens) {
  db.saveGoogleTokens(tokens);
}

export async function exchangeCode(code) {
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  saveTokens(tokens);
  return tokens;
}

export async function getAuthenticatedClient() {
  const tokens = loadTokens();
  if (!tokens?.refresh_token && !tokens?.access_token) {
    throw new Error('Google Drive not connected. Connect via /api/auth/google');
  }
  const oauth2 = getOAuth2Client();
  oauth2.setCredentials(tokens);
  oauth2.on('tokens', (t) => saveTokens(t));
  return oauth2;
}

export function isDriveConnected() {
  const tokens = loadTokens();
  return !!(tokens?.refresh_token || tokens?.access_token);
}

async function shareAnyoneReader(drive, fileId) {
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });
}

async function getShareMeta(drive, fileId) {
  const meta = await drive.files.get({
    fileId,
    fields: 'id, webViewLink, webContentLink, name',
  });
  return {
    fileId: meta.data.id,
    webViewLink: meta.data.webViewLink,
    webContentLink: meta.data.webContentLink,
    name: meta.data.name,
  };
}

export async function uploadResume(filePath, fileName, mimeType) {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: 'v3', auth });

  const folderId = await ensureFolder(drive, 'King Star Resumes');

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType: mimeType || 'application/pdf',
      body: fs.createReadStream(filePath),
    },
    fields: 'id, webViewLink, webContentLink, name',
  });

  await shareAnyoneReader(drive, res.data.id);
  return getShareMeta(drive, res.data.id);
}

/**
 * Upload a plain-text job summary (title, company, description) for later review.
 */
export async function uploadJobInfoText(fileName, textContent) {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: 'v3', auth });
  const folderId = await ensureFolder(drive, 'King Star Jobs');
  const body = Readable.from([String(textContent || '')]);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType: 'text/plain',
    },
    media: {
      mimeType: 'text/plain',
      body,
    },
    fields: 'id, webViewLink, webContentLink, name',
  });

  await shareAnyoneReader(drive, res.data.id);
  return getShareMeta(drive, res.data.id);
}

/** Build a reviewable .txt body for an applied job. */
export function formatJobInfoText({
  companyName,
  roleName,
  jobDescription,
  sourceUrl,
  appliedAt,
}) {
  const when = appliedAt || new Date().toISOString();
  const lines = [
    'King Star — Applied Job',
    '========================',
    '',
    `Company: ${companyName || ''}`,
    `Job title: ${roleName || ''}`,
    `Applied at: ${when}`,
    sourceUrl ? `Posting URL: ${sourceUrl}` : null,
    '',
    '--- Job description ---',
    '',
    String(jobDescription || '').trim(),
    '',
  ].filter((line) => line !== null);
  return lines.join('\n');
}

async function ensureFolder(drive, name) {
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const listed = await drive.files.list({
    q,
    fields: 'files(id, name)',
    spaces: 'drive',
  });
  if (listed.data.files?.length) return listed.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });
  return created.data.id;
}

export async function getFileMeta(fileId) {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: 'v3', auth });
  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, webViewLink, mimeType',
  });
  return meta.data;
}
