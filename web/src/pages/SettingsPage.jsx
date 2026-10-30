import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { getStoredUser } from '../auth.js';

const MASKED_KEY = '••••••••••••••••••••••••';

export default function SettingsPage() {
  const [searchParams] = useSearchParams();
  const [googleConnected, setGoogleConnected] = useState(false);
  const [openaiConfigured, setOpenaiConfigured] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [keyIsMasked, setKeyIsMasked] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [fixed, setFixed] = useState([]);
  const [pattern, setPattern] = useState('');
  const [answer, setAnswer] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const isOwner = !!getStoredUser()?.isOwner;
  // { id, question, answer, saving } while the owner edits a fixed answer
  const [editing, setEditing] = useState(null);

  async function refresh() {
    try {
      const [g, s, f] = await Promise.all([
        api.googleStatus(),
        api.getSettings(),
        api.listFixedAnswers(),
      ]);
      const configured = !!s.openaiConfigured;
      setGoogleConnected(!!g.connected);
      setOpenaiConfigured(configured);
      setFixed(f);
      if (configured) {
        setOpenaiApiKey(MASKED_KEY);
        setKeyIsMasked(true);
        setShowKey(false);
      }
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    if (searchParams.get('google') === 'connected') {
      setMsg('Google Drive connected.');
    }
  }, [searchParams]);

  async function connectGoogle() {
    const { url } = await api.googleAuthUrl();
    window.location.href = url;
  }

  async function disconnectGoogle() {
    await api.disconnectGoogle();
    setGoogleConnected(false);
    setMsg('Google Drive disconnected.');
  }

  function beginKeyEdit() {
    if (!keyIsMasked) return;
    setOpenaiApiKey('');
    setKeyIsMasked(false);
    setShowKey(false);
  }

  async function saveOpenAI(e) {
    e.preventDefault();
    if (keyIsMasked || !openaiApiKey.trim()) {
      setError('Enter a new API key to update it.');
      return;
    }
    setSavingKey(true);
    setError('');
    try {
      await api.saveSettings({ openaiApiKey: openaiApiKey.trim() });
      setOpenaiApiKey(MASKED_KEY);
      setKeyIsMasked(true);
      setShowKey(false);
      setOpenaiConfigured(true);
      setMsg('OpenAI key saved. It stays masked on this page.');
    } catch (err) {
      setError(err.message || 'Could not save key.');
    } finally {
      setSavingKey(false);
    }
  }

  async function addFixed(e) {
    e.preventDefault();
    if (!pattern.trim() || !answer.trim()) return;
    await api.saveFixedAnswer({
      questionPattern: pattern.trim(),
      answer: answer.trim(),
    });
    setPattern('');
    setAnswer('');
    setMsg('Fixed answer saved — similar phrasings share one entry by meaning.');
    await refresh();
  }

  function startEdit(item) {
    setEditing({ id: item.id, question: item.questionPattern, answer: item.answer, saving: false });
    setMsg('');
    setError('');
  }

  async function saveEdit(item) {
    if (!editing) return;
    const answerText = String(editing.answer || '').trim();
    const questionText = String(editing.question || '').trim();
    if (!answerText) {
      setError('Answer cannot be empty.');
      return;
    }
    if (!item.meaningGrouped && !questionText) {
      setError('Question cannot be empty.');
      return;
    }
    setEditing((e) => ({ ...e, saving: true }));
    try {
      const updated = await api.updateFixedAnswer(item.id, {
        answer: answerText,
        ...(item.meaningGrouped ? {} : { questionPattern: questionText }),
      });
      setFixed((prev) => prev.map((x) => (x.id === item.id ? { ...x, ...updated } : x)));
      setEditing(null);
      setMsg('Answer updated.');
    } catch (err) {
      setEditing((e) => (e ? { ...e, saving: false } : e));
      setError(err.message || 'Could not update answer.');
    }
  }

  async function removeFixed(id) {
    await api.deleteFixedAnswer(id);
    setFixed((prev) => prev.filter((x) => x.id !== id));
  }

  return (
    <div className="jr-page-settings">
      <header className="jr-settings-hero">
        <div>
          <p className="jr-settings-eyebrow">Workspace</p>
          <h1>Settings</h1>
          <p className="jr-settings-lede">
            Connect Drive, secure your OpenAI key, and keep reusable answers ready for autofill.
          </p>
        </div>
        <div className="jr-settings-hero-stats" aria-label="Status summary">
          <div className={`jr-settings-stat ${googleConnected ? 'is-on' : ''}`}>
            <span className="jr-settings-stat-label">Drive</span>
            <strong>{googleConnected ? 'Connected' : 'Offline'}</strong>
          </div>
          <div className={`jr-settings-stat ${openaiConfigured ? 'is-on' : ''}`}>
            <span className="jr-settings-stat-label">OpenAI</span>
            <strong>{openaiConfigured ? 'Ready' : 'Needs key'}</strong>
          </div>
          <div className="jr-settings-stat">
            <span className="jr-settings-stat-label">Answers</span>
            <strong>{fixed.length}</strong>
          </div>
        </div>
      </header>

      {msg && <p className="banner success">{msg}</p>}
      {error && <p className="banner error">{error}</p>}

      <div className="jr-settings-grid">
        <section className="jr-settings-card">
          <div className="jr-settings-card-icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3l8.5 4.5v4.2c0 5.1-3.5 8.8-8.5 10.3C6.5 20.5 3 16.8 3 11.7V7.5L12 3z" />
              <path d="M9.5 12.2l1.7 1.7 3.5-3.8" />
            </svg>
          </div>
          <div className="jr-settings-card-head">
            <h2>Google Drive</h2>
            <span className={`status-pill ${googleConnected ? 'on' : 'off'}`}>
              {googleConnected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <p className="jr-settings-card-copy">
            Resumes from the extension land in a “King Star Resumes” folder with shareable links.
          </p>
          <div className="jr-settings-card-actions">
            {googleConnected ? (
              <button type="button" className="jr-settings-btn jr-settings-btn-ghost" onClick={disconnectGoogle}>
                Disconnect
              </button>
            ) : (
              <button type="button" className="jr-settings-btn jr-settings-btn-primary" onClick={connectGoogle}>
                Connect Google Drive
              </button>
            )}
          </div>
        </section>

        <section className="jr-settings-card">
          <div className="jr-settings-card-icon is-ai" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          </div>
          <div className="jr-settings-card-head">
            <h2>OpenAI</h2>
            <span className={`status-pill ${openaiConfigured ? 'on' : 'off'}`}>
              {openaiConfigured ? 'Key configured' : 'Key missing'}
            </span>
          </div>
          <p className="jr-settings-card-copy">
            Powers AI answers for long application questions.
            {openaiConfigured
              ? ' Your key is stored on the server and shown masked below.'
              : ' Add a key to enable generation.'}
          </p>
          <form onSubmit={saveOpenAI} className="jr-settings-form">
            <label htmlFor="openai">API key</label>
            <div className="jr-key-field">
              <input
                id="openai"
                type={showKey && !keyIsMasked ? 'text' : 'password'}
                value={openaiApiKey}
                onChange={(e) => {
                  setOpenaiApiKey(e.target.value);
                  setKeyIsMasked(false);
                }}
                onFocus={beginKeyEdit}
                placeholder="sk-…"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="openai-hint"
              />
              {!keyIsMasked && (
                <button
                  type="button"
                  className="jr-key-toggle"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? 'Hide API key' : 'Show API key'}
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
              )}
            </div>
            <p id="openai-hint" className="jr-settings-hint">
              {keyIsMasked
                ? 'Password-style mask — click the field to replace the saved key.'
                : 'Key is hidden by default. Use Show only while editing.'}
            </p>
            <div className="jr-settings-card-actions">
              <button
                type="submit"
                className="jr-settings-btn jr-settings-btn-primary"
                disabled={savingKey || keyIsMasked || !openaiApiKey.trim()}
              >
                {savingKey ? 'Saving…' : openaiConfigured ? 'Update key' : 'Save key'}
              </button>
              {openaiConfigured && !keyIsMasked && (
                <button
                  type="button"
                  className="jr-settings-btn jr-settings-btn-ghost"
                  onClick={() => {
                    setOpenaiApiKey(MASKED_KEY);
                    setKeyIsMasked(true);
                    setShowKey(false);
                    setError('');
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </section>

        <section className="jr-settings-card jr-settings-card-wide">
          <div className="jr-settings-card-head">
            <div>
              <h2>Fixed answers</h2>
              <p className="jr-settings-card-copy jr-settings-card-copy-tight">
                Similar questions share one card by meaning (sponsorship, work auth, LGBTQ+,
                US residence, …). Prefer <Link to="/profile">Profile</Link> when possible.
              </p>
            </div>
            <span className="status-pill muted-pill">{fixed.length} saved</span>
          </div>

          <form onSubmit={addFixed} className="jr-settings-form jr-settings-form-inline">
            <div className="jr-settings-form-grid">
              <div>
                <label htmlFor="pattern">Question or topic</label>
                <input
                  id="pattern"
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder="e.g. visa sponsorship"
                />
              </div>
              <div>
                <label htmlFor="answer">Answer</label>
                <input
                  id="answer"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="e.g. No"
                />
              </div>
            </div>
            <button type="submit" className="jr-settings-btn jr-settings-btn-primary">
              Add answer
            </button>
          </form>

          <ul className="jr-fixed-list">
            {fixed.map((item) => (
              <li key={item.id} className={item.meaningGrouped || item.intent ? 'jr-fixed-meaning' : undefined}>
                {editing?.id === item.id ? (
                  <form
                    className="jr-fixed-edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveEdit(item);
                    }}
                  >
                    {item.meaningGrouped ? (
                      <strong title="Grouped by meaning — the label is fixed">{item.questionPattern}</strong>
                    ) : (
                      <label>
                        <span>Question</span>
                        <input
                          value={editing.question}
                          onChange={(e) => setEditing((s) => ({ ...s, question: e.target.value }))}
                          aria-label="Question"
                        />
                      </label>
                    )}
                    <label>
                      <span>Answer</span>
                      <textarea
                        rows={2}
                        value={editing.answer}
                        autoFocus
                        onChange={(e) => setEditing((s) => ({ ...s, answer: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditing(null);
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            saveEdit(item);
                          }
                        }}
                        aria-label={`Answer for ${item.questionPattern}`}
                      />
                    </label>
                    <div className="jr-fixed-edit-actions">
                      <button type="submit" className="jr-settings-btn jr-settings-btn-primary" disabled={editing.saving}>
                        {editing.saving ? 'Saving…' : 'Save'}
                      </button>
                      <button type="button" className="jr-settings-btn" onClick={() => setEditing(null)} disabled={editing.saving}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                <div className="jr-fixed-item-main">
                  <div className="jr-fixed-item-title">
                    <strong>{item.questionPattern}</strong>
                    {item.meaningGrouped || item.intent ? (
                      <span
                        className="jr-fixed-intent"
                        title="One answer covers all similar phrasings of this question"
                      >
                        meaning
                      </span>
                    ) : null}
                  </div>
                  <p className="jr-fixed-answer">{item.answer}</p>
                </div>
                )}
                {editing?.id !== item.id && (
                  <div className="jr-fixed-actions">
                    {isOwner && (
                      <button type="button" className="jr-fixed-edit-btn" onClick={() => startEdit(item)}>
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      className="jr-fixed-delete"
                      onClick={() => removeFixed(item.id)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
            {fixed.length === 0 && (
              <li className="jr-fixed-empty">
                No fixed answers yet — add one above or finish your profile.
              </li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
