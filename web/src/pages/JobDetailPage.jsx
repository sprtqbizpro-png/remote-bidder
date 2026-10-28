import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import JobDescriptionView from '../components/JobDescriptionView.jsx';
import ResumeViewer from '../components/ResumeViewer.jsx';
import { structureJobDescription } from '../lib/jobDescription.js';
import { driveOpenUrl } from '../lib/drive.js';

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : `${iso}Z`);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

export default function JobDetailPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [panel, setPanel] = useState(
    searchParams.get('view') === 'resume' ? 'resume' : 'description'
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getJob(id);
        if (!cancelled) setJob(data);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (searchParams.get('view') === 'resume') setPanel('resume');
  }, [searchParams]);

  function downloadTxt() {
    if (!job) return;
    const desc = structureJobDescription(job.jobDescription || '');
    const body = [
      'King Star — Applied Job',
      '========================',
      '',
      `Company: ${job.companyName || ''}`,
      `Job title: ${job.roleName || ''}`,
      job.appliedAt ? `Applied at: ${job.appliedAt}` : null,
      job.sourceUrl ? `Posting URL: ${job.sourceUrl}` : null,
      '',
      '--- Job description ---',
      '',
      desc,
      '',
    ]
      .filter((line) => line !== null)
      .join('\n');
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${job.companyName}-${job.roleName}-job-info.txt`.replace(/[^\w.-]+/g, '_');
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <div className="jr-page-detail">
        <div className="jr-detail-loading" aria-busy="true">
          <div className="skeleton" style={{ height: 160, borderRadius: 18 }} />
          <div className="skeleton" style={{ height: 420, borderRadius: 18 }} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="jr-page-detail">
        <p className="banner error">{error}</p>
        <Link to="/" className="jr-detail-back">
          ← Back to jobs
        </Link>
      </div>
    );
  }

  if (!job) return null;

  const hasResume = !!(job.resumeDriveLink || job.resumeDriveFileId);
  const resumeOpen = driveOpenUrl({
    fileId: job.resumeDriveFileId,
    link: job.resumeDriveLink,
  });
  const jobInfoOpen = driveOpenUrl({
    fileId: job.jobInfoDriveFileId,
    link: job.jobInfoDriveLink,
  });

  return (
    <div className="jr-page-detail">
      <div className="jr-detail-topbar">
        <Link to="/" className="jr-detail-back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          All jobs
        </Link>
        <div className="jr-detail-tabs" role="tablist" aria-label="Job content">
          <button
            type="button"
            role="tab"
            aria-selected={panel === 'description'}
            className={panel === 'description' ? 'is-active' : ''}
            onClick={() => setPanel('description')}
          >
            Description
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panel === 'resume'}
            className={panel === 'resume' ? 'is-active' : ''}
            onClick={() => setPanel('resume')}
          >
            Resume
            {hasResume ? <span className="jr-detail-tab-dot" aria-hidden="true" /> : null}
          </button>
        </div>
      </div>

      <header className="jr-detail-hero">
        <div className="jr-detail-hero-main">
          <div className="jr-job-logo jr-detail-logo" aria-hidden="true">
            {initials(job.companyName)}
          </div>
          <div className="jr-detail-hero-text">
            <p className="jr-detail-company">{job.companyName}</p>
            <h1>{job.roleName}</h1>
            <div className="jr-detail-chips">
              {job.appliedAt && (
                <span className="jr-detail-chip">Applied {formatDate(job.appliedAt)}</span>
              )}
              {hasResume ? (
                <span className="jr-detail-chip is-ok">Resume on Drive</span>
              ) : (
                <span className="jr-detail-chip">No resume</span>
              )}
              {jobInfoOpen && <span className="jr-detail-chip">Job info .txt</span>}
              {job.sourceUrl && <span className="jr-detail-chip">Source saved</span>}
            </div>
          </div>
        </div>

        <div className="jr-detail-actions">
          {job.sourceUrl && (
            <a
              className="jr-detail-btn jr-detail-btn-ghost"
              href={job.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Original posting
            </a>
          )}
          {hasResume && (
            <button
              type="button"
              className="jr-detail-btn jr-detail-btn-primary"
              onClick={() => {
                setPanel('resume');
                requestAnimationFrame(() => {
                  document
                    .getElementById('job-resume-panel')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                });
              }}
            >
              View resume
            </button>
          )}
          {jobInfoOpen && (
            <a
              className="jr-detail-btn jr-detail-btn-ghost"
              href={jobInfoOpen}
              target="_blank"
              rel="noopener noreferrer"
            >
              Job info on Drive
            </a>
          )}
          <button type="button" className="jr-detail-btn jr-detail-btn-ghost" onClick={downloadTxt}>
            Download .txt
          </button>
        </div>
      </header>

      <div className={`jr-detail-layout is-${panel}`}>
        <section
          className={`jr-detail-pane jr-detail-desc${panel === 'description' ? ' is-visible' : ''}`}
          aria-label="Job description"
        >
          <div className="jr-detail-card jr-detail-card-fill">
            <div className="jr-detail-card-head">
              <span>Job description</span>
              <span className="jr-detail-card-hint">Cleaned & structured</span>
            </div>
            <div className="jr-detail-card-body">
              <JobDescriptionView text={job.jobDescription} />
            </div>
          </div>
        </section>

        <section
          id="job-resume-panel"
          className={`jr-detail-pane jr-detail-resume${panel === 'resume' ? ' is-visible' : ''}`}
          aria-label="Resume"
        >
          <div className="jr-detail-card jr-detail-card-resume jr-detail-card-fill">
            <div className="jr-detail-card-head">
              <span>Resume preview</span>
              <span className="jr-detail-card-hint">Google Drive</span>
            </div>
            <div className="jr-detail-card-body jr-detail-card-body-flush">
              <ResumeViewer
                fileId={job.resumeDriveFileId}
                link={job.resumeDriveLink}
                emptyHint="Upload a resume from the Chrome extension when you mark a job as applied."
              />
            </div>
          </div>

          {(resumeOpen || jobInfoOpen) && (
            <div className="jr-detail-drive-links">
              <div className="jr-detail-drive-row">
                {resumeOpen && (
                  <a href={resumeOpen} target="_blank" rel="noopener noreferrer" className="jr-detail-drive-link">
                    <span className="jr-detail-drive-ico" aria-hidden="true">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <path d="M14 2v6h6" />
                      </svg>
                    </span>
                    <span>
                      <strong>Resume</strong>
                      <small>Open in Google Drive</small>
                    </span>
                  </a>
                )}
                {jobInfoOpen && (
                  <a href={jobInfoOpen} target="_blank" rel="noopener noreferrer" className="jr-detail-drive-link">
                    <span className="jr-detail-drive-ico" aria-hidden="true">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <path d="M14 2v6h6" />
                        <path d="M8 13h8M8 17h6" />
                      </svg>
                    </span>
                    <span>
                      <strong>Job info .txt</strong>
                      <small>Application summary</small>
                    </span>
                  </a>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
