import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { getStoredUser } from '../auth.js';

function formatRelative(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : `${iso}Z`);
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${Math.max(1, mins)}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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

function statusMeta(job) {
  return {
    hasResume: !!job.resumeDriveLink,
    hasJobInfo: !!job.jobInfoDriveLink,
    hasSource: !!job.sourceUrl,
  };
}

const PAGE_SIZE = 8;

function buildPageItems(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages = new Set([1, total, current, current - 1, current + 1]);
  if (current <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }
  if (current >= total - 2) {
    pages.add(total - 1);
    pages.add(total - 2);
    pages.add(total - 3);
  }
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const items = [];
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) items.push('…');
    items.push(sorted[i]);
  }
  return items;
}

const JOBS_POLL_MS = 15000;

export default function JobsPage() {
  const user = getStoredUser();
  const canRemoveJobs = !!user?.isOwner;
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('applied');
  const [page, setPage] = useState(1);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  async function loadJobs({ quiet = false } = {}) {
    try {
      const data = await api.listJobs();
      setJobs(Array.isArray(data) ? data : []);
      setError('');
      setLastSyncedAt(new Date());
    } catch (err) {
      if (!quiet) setError(err.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await loadJobs({ quiet: false });
    })();

    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      loadJobs({ quiet: true });
    }, JOBS_POLL_MS);

    const onFocus = () => loadJobs({ quiet: true });
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((job) =>
      [
        job.companyName,
        job.roleName,
        job.jobDescription,
        job.createdBy?.name,
        job.createdBy?.email,
      ]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q))
    );
  }, [jobs, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, currentPage]);

  const rangeStart = filtered.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(currentPage * PAGE_SIZE, filtered.length);
  const pageNumbers = useMemo(
    () => buildPageItems(currentPage, totalPages),
    [currentPage, totalPages]
  );

  useEffect(() => {
    setPage(1);
  }, [query]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  async function handleDelete(id) {
    if (!confirm('Remove this applied job from King Star?')) return;
    await api.deleteJob(id);
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }

  function goToPage(next) {
    const clamped = Math.min(Math.max(1, next), totalPages);
    setPage(clamped);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div className="jr-page-jobs">
      <header className="jr-page-head">
        <div className="jr-page-head-main">
          <h1>Jobs</h1>
          <div className="jr-page-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={tab === 'applied' ? 'is-active' : ''}
              onClick={() => setTab('applied')}
            >
              Applied ({jobs.length})
            </button>
            <button type="button" role="tab" className="is-disabled" disabled title="Coming soon">
              Recommended
            </button>
          </div>
          {lastSyncedAt ? (
            <p className="jr-jobs-sync-meta" aria-live="polite">
              Updated {formatRelative(lastSyncedAt.toISOString())} · auto-refreshes every 15s
            </p>
          ) : null}
        </div>
        <div className="jr-page-search">
          <input
            type="search"
            placeholder="Search company or role…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search jobs"
          />
        </div>
      </header>

      {loading && (
        <div className="jr-jobs-loading" aria-busy="true">
          <div className="skeleton" style={{ height: 280, borderRadius: 18 }} />
        </div>
      )}

      {error && <p className="banner error">{error}</p>}

      {!loading && !error && jobs.length === 0 && (
        <div className="jr-jobs-empty">
          <div className="jr-jobs-empty-card">
            <h2>No applications yet</h2>
            <p>
              Use the Chrome extension on a job page to extract details, autofill, and save — they
              appear here.
            </p>
            <div className="jr-jobs-empty-actions">
              <Link to="/profile" className="btn">
                Complete profile
              </Link>
              <Link to="/settings" className="btn btn-ghost">
                Settings
              </Link>
            </div>
          </div>
        </div>
      )}

      {!loading && !error && jobs.length > 0 && filtered.length === 0 && (
        <div className="jr-jobs-empty">
          <div className="jr-jobs-empty-card">
            <h2>No matches</h2>
            <p>Try a different company or role keyword.</p>
          </div>
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <>
          <div className="jr-table-wrap">
            <table className="jr-jobs-table">
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Created by</th>
                  <th scope="col">Applied</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="jr-th-actions">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((job) => {
                  const status = statusMeta(job);
                  return (
                    <tr key={job.id}>
                      <td className="jr-td-role">
                        <div className="jr-table-role">
                          <div className="jr-job-logo jr-table-logo" aria-hidden="true">
                            {initials(job.companyName)}
                          </div>
                          <div className="jr-table-role-text">
                            <Link to={`/jobs/${job.id}`} className="jr-table-role-link">
                              {job.roleName}
                            </Link>
                            <span className="jr-table-company">{job.companyName}</span>
                          </div>
                        </div>
                      </td>
                      <td className="jr-td-created-by">
                        <div className="jr-created-by">
                          <span className="jr-created-by-name">
                            {job.createdBy?.name || job.createdBy?.email || '—'}
                          </span>
                          {job.createdBy?.email && job.createdBy?.name ? (
                            <span className="jr-created-by-email">{job.createdBy.email}</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="jr-td-date">
                        <time dateTime={job.appliedAt || undefined}>{formatRelative(job.appliedAt)}</time>
                      </td>
                      <td className="jr-td-status">
                        <div className="jr-table-badges">
                          {status.hasResume ? (
                            <span className="jr-badge is-ok">Resume</span>
                          ) : (
                            <span className="jr-badge">No resume</span>
                          )}
                          {status.hasJobInfo && <span className="jr-badge">Job info</span>}
                          {status.hasSource && <span className="jr-badge">Source</span>}
                        </div>
                      </td>
                      <td className="jr-td-actions">
                        <div className="jr-table-actions">
                          <Link to={`/jobs/${job.id}`} className="jr-table-btn jr-table-btn-primary">
                            Details
                          </Link>
                          {job.resumeDriveLink ? (
                            <Link
                              to={`/jobs/${job.id}?view=resume`}
                              className="jr-table-btn jr-table-btn-accent"
                            >
                              Resume
                            </Link>
                          ) : job.sourceUrl ? (
                            <a
                              className="jr-table-btn jr-table-btn-ghost"
                              href={job.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Posting
                            </a>
                          ) : null}
                          {canRemoveJobs ? (
                            <button
                              type="button"
                              className="jr-table-btn jr-table-btn-danger"
                              onClick={() => handleDelete(job.id)}
                              aria-label={`Remove ${job.roleName}`}
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <nav className="jr-pagination" aria-label="Jobs pagination">
            <p className="jr-pagination-meta">
              Showing <strong>{rangeStart}–{rangeEnd}</strong> of <strong>{filtered.length}</strong>
            </p>
            <div className="jr-pagination-controls">
              <button
                type="button"
                className="jr-page-btn"
                disabled={currentPage <= 1}
                onClick={() => goToPage(currentPage - 1)}
                aria-label="Previous page"
              >
                Previous
              </button>
              <div className="jr-page-numbers" role="list">
                {pageNumbers.map((item, idx) =>
                  item === '…' ? (
                    <span key={`ellipsis-${idx}`} className="jr-page-ellipsis" aria-hidden="true">
                      …
                    </span>
                  ) : (
                    <button
                      key={item}
                      type="button"
                      role="listitem"
                      className={`jr-page-num${item === currentPage ? ' is-active' : ''}`}
                      aria-current={item === currentPage ? 'page' : undefined}
                      onClick={() => goToPage(item)}
                    >
                      {item}
                    </button>
                  )
                )}
              </div>
              <button
                type="button"
                className="jr-page-btn"
                disabled={currentPage >= totalPages}
                onClick={() => goToPage(currentPage + 1)}
                aria-label="Next page"
              >
                Next
              </button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
