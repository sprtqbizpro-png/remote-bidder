/**
 * Helpers for Google Drive share / preview URLs.
 */

export function driveFileIdFromLink(link) {
  if (!link) return null;
  const s = String(link);
  const byPath = s.match(/\/(?:file|document|presentation|spreadsheets)\/d\/([a-zA-Z0-9_-]+)/);
  if (byPath) return byPath[1];
  const byQuery = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return byQuery ? byQuery[1] : null;
}

/** In-browser preview URL suitable for iframe embed. */
export function drivePreviewUrl({ fileId, link } = {}) {
  const id = fileId || driveFileIdFromLink(link);
  if (id) return `https://drive.google.com/file/d/${id}/preview`;
  return link || null;
}

/** Open-in-Drive / Docs URL. */
export function driveOpenUrl({ fileId, link } = {}) {
  if (link) return link;
  if (fileId) return `https://drive.google.com/file/d/${fileId}/view`;
  return null;
}

/** Direct download URL for a Drive file. */
export function driveDownloadUrl({ fileId, link } = {}) {
  const id = fileId || driveFileIdFromLink(link);
  if (!id) return null;
  return `https://drive.google.com/uc?export=download&id=${id}`;
}
