import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../api.js';
import { getStoredUser } from '../auth.js';

const emptyForm = { email: '', password: '', name: '' };

export default function MembersPage() {
  const user = getStoredUser();
  const isOwner = !!user?.isOwner;
  const passwordRef = useRef(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [passwordOnly, setPasswordOnly] = useState(false);

  async function refresh() {
    try {
      const data = await api.listMembers();
      setMembers(Array.isArray(data) ? data : []);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return undefined;
    }
    refresh();
    return undefined;
  }, [isOwner]);

  if (!isOwner) {
    return <Navigate to="/" replace />;
  }

  function startEdit(member, { focusPassword = false } = {}) {
    setEditingId(member.id);
    setPasswordOnly(focusPassword);
    setForm({
      email: member.email || '',
      password: '',
      name: member.name || '',
    });
    setMsg('');
    setError('');
    if (focusPassword) {
      requestAnimationFrame(() => passwordRef.current?.focus());
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setPasswordOnly(false);
    setForm(emptyForm);
  }

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setMsg('');
    try {
      if (editingId) {
        const payload = {};
        if (!passwordOnly) {
          payload.email = form.email.trim();
          payload.name = form.name.trim();
        }
        if (form.password.trim()) {
          payload.password = form.password.trim();
        } else if (passwordOnly) {
          throw new Error('Enter a new password (at least 6 characters).');
        }
        if (!payload.password && passwordOnly) {
          throw new Error('Enter a new password (at least 6 characters).');
        }
        if (!Object.keys(payload).length) {
          throw new Error('Nothing to update.');
        }
        await api.updateMember(editingId, payload);
        setMsg(payload.password ? 'Password updated.' : 'Member updated.');
      } else {
        await api.createMember({
          email: form.email.trim(),
          password: form.password,
          name: form.name.trim(),
        });
        setMsg('Member added.');
      }
      setForm(emptyForm);
      setEditingId(null);
      setPasswordOnly(false);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onRemove(member) {
    if (member.isOwner || member.role === 'owner') {
      setError('Cannot remove the owner account.');
      return;
    }
    if (!confirm(`Remove member ${member.email}?`)) return;
    setError('');
    setMsg('');
    try {
      await api.deleteMember(member.id);
      setMsg('Member removed.');
      if (editingId === member.id) cancelEdit();
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  const editingMember = editingId ? members.find((m) => m.id === editingId) : null;

  return (
    <div className="jr-page-jobs">
      <header className="jr-page-head">
        <div className="jr-page-head-main">
          <h1>Members</h1>
          <p className="jr-members-lede">
            Add people who can sign in to the web app and Chrome extension. Everyone shares the
            owner profile for autofill.
          </p>
        </div>
      </header>

      {msg && <p className="banner success">{msg}</p>}
      {error && <p className="banner error">{error}</p>}

      <section className="jr-members-panel">
        <h2>
          {editingId
            ? passwordOnly
              ? `Change password — ${editingMember?.email || ''}`
              : 'Edit member'
            : 'Add member'}
        </h2>
        <form className="jr-members-form" onSubmit={onSubmit}>
          {!passwordOnly ? (
            <>
              <label>
                Name
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Display name"
                  autoComplete="off"
                />
              </label>
              <label>
                Email
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="member@example.com"
                  autoComplete="off"
                  disabled={!!editingMember?.isOwner}
                />
              </label>
            </>
          ) : null}
          <label className={passwordOnly ? 'jr-members-password-wide' : undefined}>
            {editingId ? 'New password' : 'Password'}
            {!editingId || passwordOnly ? null : (
              <span className="jr-members-field-hint"> Optional — leave blank to keep current</span>
            )}
            <input
              ref={passwordRef}
              type="password"
              required={!editingId || passwordOnly}
              minLength={6}
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              placeholder="At least 6 characters"
              autoComplete="new-password"
            />
          </label>
          <div className="jr-members-form-actions">
            <button type="submit" className="btn" disabled={saving}>
              {saving
                ? 'Saving…'
                : editingId
                  ? passwordOnly
                    ? 'Update password'
                    : 'Update member'
                  : 'Add member'}
            </button>
            {editingId ? (
              <button type="button" className="btn btn-ghost" onClick={cancelEdit}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      </section>

      {loading ? (
        <div className="jr-jobs-loading" aria-busy="true">
          <div className="skeleton" style={{ height: 200, borderRadius: 18 }} />
        </div>
      ) : (
        <div className="jr-table-wrap">
          <table className="jr-jobs-table jr-members-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col" className="jr-th-actions">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td>{member.name || '—'}</td>
                  <td>{member.email}</td>
                  <td>
                    <span className={`jr-badge${member.isOwner ? ' is-ok' : ''}`}>
                      {member.isOwner ? 'Owner' : 'Member'}
                    </span>
                  </td>
                  <td className="jr-td-actions">
                    <div className="jr-table-actions">
                      <button
                        type="button"
                        className="jr-table-btn jr-table-btn-primary"
                        onClick={() => startEdit(member)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="jr-table-btn jr-table-btn-accent"
                        onClick={() => startEdit(member, { focusPassword: true })}
                      >
                        Password
                      </button>
                      {!member.isOwner ? (
                        <button
                          type="button"
                          className="jr-table-btn jr-table-btn-danger"
                          onClick={() => onRemove(member)}
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {members.length === 0 ? (
                <tr>
                  <td colSpan={4}>No members yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
