import { driveOpenUrl, drivePreviewUrl } from '../lib/drive.js';

export default function ResumeViewer({
  fileId,
  link,
  title = 'Resume',
  emptyHint = 'No resume was saved for this application.',
}) {
  const preview = drivePreviewUrl({ fileId, link });
  const openHref = driveOpenUrl({ fileId, link });

  if (!preview && !openHref) {
    return (
      <div className="jr-resume-empty">
        <div className="jr-resume-empty-icon" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M8 13h8M8 17h5" />
          </svg>
        </div>
        <p className="jr-resume-empty-title">No resume linked</p>
        <p className="jr-resume-empty-hint">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="jr-resume-viewer">
      <div className="jr-resume-viewer-bar">
        <div className="jr-resume-viewer-title">
          <span className="jr-resume-viewer-dot" aria-hidden="true" />
          <span>{title}</span>
        </div>
        {openHref && (
          <a
            className="jr-resume-open"
            href={openHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in Drive
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <path d="M15 3h6v6" />
              <path d="M10 14L21 3" />
            </svg>
          </a>
        )}
      </div>
      {preview ? (
        <div className="jr-resume-frame-wrap">
          <iframe
            className="jr-resume-frame"
            title={`${title} preview`}
            src={preview}
            allow="autoplay"
          />
        </div>
      ) : (
        <div className="jr-resume-empty jr-resume-empty-compact">
          <p className="jr-resume-empty-hint">
            Preview unavailable. Use Open in Drive to view the file.
          </p>
          {openHref && (
            <a className="jr-job-apply" href={openHref} target="_blank" rel="noopener noreferrer">
              Open resume
            </a>
          )}
        </div>
      )}
    </div>
  );
}
