import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { getStoredUser } from '../auth.js';

function parseAppliedDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso.includes('Z') || iso.includes('+') ? iso : `${iso}Z`);
  } catch {
    return null;
  }
}

/** Under 24h: relative. 24h+: applied date/time. */
function formatAppliedAt(iso) {
  if (!iso) return '—';
  const d = parseAppliedDate(iso);
  if (!d || Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const hrs = diffMs / 3600000;
  if (hrs < 24) {
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${Math.max(1, mins)}m ago`;
    return `${Math.floor(hrs)}h ago`;
  }
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatRelativeShort(iso) {
  if (!iso) return '—';
  const d = parseAppliedDate(iso) || (iso instanceof Date ? iso : new Date(iso));
  if (!d || Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
    hasResume: !!(job.resumeDriveLink || job.resumeDriveFileId),
    hasJobInfo: !!(job.jobInfoDriveLink || job.jobInfoDriveFileId),
    hasSource: !!job.sourceUrl,
  };
}

function creatorKey(job) {
  return String(job.createdBy?.email || job.createdBy?.name || '').trim().toLowerCase();
}

function creatorLabel(job) {
  return job.createdBy?.name || job.createdBy?.email || '';
}

const PAGE_SIZE = 8;
const JOBS_POLL_MS = 60000;

const DATE_PRESETS = [
  { id: 'all', label: 'Any time' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
];

const STATUS_PRESETS = [
  { id: 'all', label: 'Any status' },
  { id: 'resume', label: 'Has resume' },
  { id: 'no-resume', label: 'No resume' },
  { id: 'job-info', label: 'Has job info' },
  { id: 'source', label: 'Has source' },
];

const SORT_PRESETS = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'company', label: 'Company A–Z' },
  { id: 'role', label: 'Role A–Z' },
];

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

const emptyFilters = {
  query: '',
  company: '',
  createdBy: '',
  dateRange: 'all',
  status: 'all',
  sort: 'newest',
};

export default function JobsPage() {
  const user = getStoredUser();
  const canRemoveJobs = !!user?.isOwner;
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(emptyFilters);
  const [tab, setTab] = useState('applied');
  const [page, setPage] = useState(1);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  // { id, roleName, companyName, saving, error } while a row is being edited (any member)
  const [editing, setEditing] = useState(null);

  function patchFilter(patch) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

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

  const companies = useMemo(() => {
    const set = new Set();
    jobs.forEach((j) => {
      const c = String(j.companyName || '').trim();
      if (c) set.add(c);
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [jobs]);

  const creators = useMemo(() => {
    const map = new Map();
    jobs.forEach((j) => {
      const key = creatorKey(j);
      const label = creatorLabel(j);
      if (key && label) map.set(key, label);
    });
    return [...map.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [jobs]);

  const filtered = useMemo(() => {
    const q = filters.query.trim().toLowerCase();
    const companyQ = filters.company.trim().toLowerCase();
    const now = Date.now();

    let list = jobs.filter((job) => {
      if (q) {
        const hay = [
          job.companyName,
          job.roleName,
          job.jobDescription,
          job.createdBy?.name,
          job.createdBy?.email,
          job.sourceUrl,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }

      if (companyQ && String(job.companyName || '').toLowerCase() !== companyQ) {
        return false;
      }

      if (filters.createdBy) {
        if (creatorKey(job) !== filters.createdBy) return false;
      }

      if (filters.dateRange !== 'all') {
        const d = parseAppliedDate(job.appliedAt);
        if (!d) return false;
        const ageMs = now - d.getTime();
        if (filters.dateRange === '24h' && ageMs > 24 * 3600000) return false;
        if (filters.dateRange === '7d' && ageMs > 7 * 24 * 3600000) return false;
        if (filters.dateRange === '30d' && ageMs > 30 * 24 * 3600000) return false;
      }

      const status = statusMeta(job);
      if (filters.status === 'resume' && !status.hasResume) return false;
      if (filters.status === 'no-resume' && status.hasResume) return false;
      if (filters.status === 'job-info' && !status.hasJobInfo) return false;
      if (filters.status === 'source' && !status.hasSource) return false;

      return true;
    });

    const sorted = list.slice();
    sorted.sort((a, b) => {
      if (filters.sort === 'oldest') {
        return String(a.appliedAt || '').localeCompare(String(b.appliedAt || ''));
      }
      if (filters.sort === 'company') {
        return String(a.companyName || '').localeCompare(String(b.companyName || ''));
      }
      if (filters.sort === 'role') {
        return String(a.roleName || '').localeCompare(String(b.roleName || ''));
      }
      // newest
      return String(b.appliedAt || '').localeCompare(String(a.appliedAt || ''));
    });
    return sorted;
  }, [jobs, filters]);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.query.trim()) n += 1;
    if (filters.company) n += 1;
    if (filters.createdBy) n += 1;
    if (filters.dateRange !== 'all') n += 1;
    if (filters.status !== 'all') n += 1;
    if (filters.sort !== 'newest') n += 1;
    return n;
  }, [filters]);

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
  }, [
    filters.query,
    filters.company,
    filters.createdBy,
    filters.dateRange,
    filters.status,
    filters.sort,
  ]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  function startEdit(job) {
    setEditing({ id: job.id, roleName: job.roleName || '', companyName: job.companyName || '', saving: false, error: '' });
  }

  async function saveEdit() {
    if (!editing) return;
    const roleName = editing.roleName.trim();
    const companyName = editing.companyName.trim();
    if (!roleName || !companyName) {
      setEditing((e) => ({ ...e, error: 'Job title and company are required.' }));
      return;
    }
    setEditing((e) => ({ ...e, saving: true, error: '' }));
    try {
      const updated = await api.updateJob(editing.id, { roleName, companyName });
      setJobs((prev) => prev.map((j) => (j.id === updated.id ? { ...j, ...updated } : j)));
      setEditing(null);
    } catch (err) {
      setEditing((e) => (e ? { ...e, saving: false, error: err.message || 'Could not save.' } : e));
    }
  }

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

  function clearFilters() {
    setFilters(emptyFilters);
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
              Updated {formatRelativeShort(lastSyncedAt)} · auto-refreshes every 15s
            </p>
          ) : null}
        </div>
      </header>

      {!loading && jobs.length > 0 && (
        <section className="jr-jobs-filters" aria-label="Filter and search jobs">
          <div className="jr-jobs-filters-row">
            <label className="jr-jobs-filter-field jr-jobs-filter-search">
              <span className="jr-jobs-filter-label">Search</span>
              <input
                type="search"
                placeholder="Company, role, creator, keywords…"
                value={filters.query}
                onChange={(e) => patchFilter({ query: e.target.value })}
                aria-label="Search jobs"
              />
            </label>
            <label className="jr-jobs-filter-field">
              <span className="jr-jobs-filter-label">Company</span>
              <select
                value={filters.company}
                onChange={(e) => patchFilter({ company: e.target.value })}
                aria-label="Filter by company"
              >
                <option value="">All companies</option>
                {companies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="jr-jobs-filter-field">
              <span className="jr-jobs-filter-label">Created by</span>
              <select
                value={filters.createdBy}
                onChange={(e) => patchFilter({ createdBy: e.target.value })}
                aria-label="Filter by creator"
              >
                <option value="">Anyone</option>
                {creators.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="jr-jobs-filter-field">
              <span className="jr-jobs-filter-label">Applied</span>
              <select
                value={filters.dateRange}
                onChange={(e) => patchFilter({ dateRange: e.target.value })}
                aria-label="Filter by applied date"
              >
                {DATE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="jr-jobs-filter-field">
              <span className="jr-jobs-filter-label">Status</span>
              <select
                value={filters.status}
                onChange={(e) => patchFilter({ status: e.target.value })}
                aria-label="Filter by status"
              >
                {STATUS_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="jr-jobs-filter-field">
              <span className="jr-jobs-filter-label">Sort</span>
              <select
                value={filters.sort}
                onChange={(e) => patchFilter({ sort: e.target.value })}
                aria-label="Sort jobs"
              >
                {SORT_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="jr-jobs-filters-foot">
            <p className="jr-jobs-filters-count">
              Showing <strong>{filtered.length}</strong> of <strong>{jobs.length}</strong>
              {activeFilterCount ? (
                <>
                  {' '}
                  · <strong>{activeFilterCount}</strong> filter
                  {activeFilterCount === 1 ? '' : 's'} active
                </>
              ) : null}
            </p>
            {activeFilterCount > 0 ? (
              <button type="button" className="jr-jobs-filters-clear" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
          </div>
        </section>
      )}

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
            <p>Try adjusting search or filters.</p>
            <button type="button" className="btn btn-ghost" onClick={clearFilters}>
              Clear filters
            </button>
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
                          {editing?.id === job.id ? (
                            <form
                              className="jr-table-role-edit"
                              onSubmit={(e) => {
                                e.preventDefault();
                                saveEdit();
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') setEditing(null);
                              }}
                            >
                              <input
                                value={editing.roleName}
                                onChange={(e) => setEditing((s) => ({ ...s, roleName: e.target.value }))}
                                placeholder="Job title"
                                aria-label="Job title"
                                autoFocus
                              />
                              <input
                                value={editing.companyName}
                                onChange={(e) => setEditing((s) => ({ ...s, companyName: e.target.value }))}
                                placeholder="Company"
                                aria-label="Company"
                              />
                              <div className="jr-table-role-edit-actions">
                                <button type="submit" className="jr-table-btn jr-table-btn-primary" disabled={editing.saving}>
                                  {editing.saving ? 'Saving…' : 'Save'}
                                </button>
                                <button type="button" className="jr-table-btn jr-table-btn-ghost" onClick={() => setEditing(null)} disabled={editing.saving}>
                                  Cancel
                                </button>
                              </div>
                              {editing.error ? <span className="jr-table-role-edit-error">{editing.error}</span> : null}
                            </form>
                          ) : (
                          <div className="jr-table-role-text">
                            <Link to={`/jobs/${job.id}`} className="jr-table-role-link">
                              {job.roleName}
                            </Link>
                            <span className="jr-table-company">{job.companyName}</span>
                          </div>
                          )}
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
                        <time dateTime={job.appliedAt || undefined}>
                          {formatAppliedAt(job.appliedAt)}
                        </time>
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
                          {job.resumeDriveLink || job.resumeDriveFileId ? (
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
                          {editing?.id !== job.id ? (
                            <button
                              type="button"
                              className="jr-table-btn jr-table-btn-ghost"
                              onClick={() => startEdit(job)}
                              aria-label={`Edit ${job.roleName}`}
                            >
                              Edit
                            </button>
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
              Showing <strong>
                {rangeStart}–{rangeEnd}
              </strong>{' '}
              of <strong>{filtered.length}</strong>
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
