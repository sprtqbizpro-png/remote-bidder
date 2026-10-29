import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { captureTokenFromUrl, clearSession, getToken } from '../auth.js';

const STEPS = [
  { id: 'personal', label: 'Personal' },
  { id: 'education', label: 'Education' },
  { id: 'equalEmployment', label: 'Equal Employment' },
];

const WORK_COUNTRIES = [
  { code: 'US', label: 'United States', flag: '🇺🇸' },
  { code: 'CA', label: 'Canada', flag: '🇨🇦' },
  { code: 'UK', label: 'United Kingdom', flag: '🇬🇧' },
  { code: 'AU', label: 'Australia', flag: '🇦🇺' },
  { code: 'IE', label: 'Ireland', flag: '🇮🇪' },
  { code: 'NZ', label: 'New Zealand', flag: '🇳🇿' },
];

const OPT = {
  yesNoDecline: ['Yes', 'No', 'Decline to state'],
  gender: ['Male', 'Female', 'Non-Binary', 'Decline to state'],
  race: [
    'American Indian or Alaskan Native',
    'Asian',
    'Black or African American',
    'Hispanic or Latino',
    'White',
    'Native Hawaiian or Other Pacific Islander',
    'Two or More Races',
    'Decline to state',
  ],
  orientation: [
    'Asexual',
    'Bisexual',
    'Gay',
    'Heterosexual',
    'Lesbian',
    'Pansexual',
    'Queer',
    'Decline to state',
  ],
  pronouns: ['He/Him', 'She/Her', 'They/Them', 'Other', 'Prefer not to say'],
  phoneType: ['Mobile', 'Home', 'Work'],
};

function emptyProfile() {
  return {
    personal: {
      firstName: '',
      middleName: '',
      lastName: '',
      email: '',
      phoneType: '',
      phone: '',
      addressLine: '',
      country: 'United States',
      state: '',
      city: '',
      county: '',
      postalCode: '',
      linkedinUrl: '',
      githubUrl: '',
      portfolioUrl: '',
    },
    education: [
      {
        schoolName: '',
        major: '',
        degreeType: '',
        gpa: '',
        startDate: '',
        endDate: '',
        currentlyStudying: false,
      },
    ],
    equalEmployment: {
      workCountries: ['US'],
      usCitizen: 'Yes',
      disability: '',
      veteran: '',
      gender: '',
      lgbtq: '',
      race: '',
      hispanicLatino: '',
      sexualOrientation: '',
      pronouns: '',
    },
    completedSteps: {
      personal: false,
      education: false,
      equalEmployment: false,
    },
    profileComplete: false,
  };
}

function Field({ label, required, children, className = '' }) {
  return (
    <label className={`jr-field ${className}`}>
      <span className="jr-label">
        {label}
        {required ? <em aria-hidden="true">*</em> : null}
      </span>
      {children}
    </label>
  );
}

function Select({ value, onChange, options, required, placeholder = 'Select' }) {
  return (
    <div className="jr-select-wrap">
      <select value={value || ''} onChange={(e) => onChange(e.target.value)} required={required}>
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function ProfilePage() {
  const navigate = useNavigate();
  const [step, setStep] = useState('personal');
  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState(emptyProfile);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const personal = profile.personal;
  const edu = profile.education?.[0] || emptyProfile().education[0];
  const ee = profile.equalEmployment;

  const bubble = useMemo(() => {
    if (step === 'personal') return '🎉 Great! Let’s get started with your basic info.';
    if (step === 'education') return 'Next, please review and confirm your education history.';
    return 'Last step! This info only helps autofill — we never share it.';
  }, [step]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  async function bootstrap() {
    captureTokenFromUrl();
    const token = getToken();
    if (!token) {
      setLoading(false);
      setUser(null);
      return;
    }
    try {
      const me = await api.me();
      setUser(me.user);
      const { profile: p } = await api.getProfile();
      const base = emptyProfile();
      setProfile({
        ...base,
        ...p,
        personal: { ...base.personal, ...(p.personal || {}) },
        education: p.education?.length ? p.education : base.education,
        equalEmployment: { ...base.equalEmployment, ...(p.equalEmployment || {}) },
        completedSteps: { ...base.completedSteps, ...(p.completedSteps || {}) },
      });
      if (!p.profileComplete) {
        setEditing(true);
        if (!p.completedSteps?.personal) setStep('personal');
        else if (!p.completedSteps?.education) setStep('education');
        else setStep('equalEmployment');
      } else {
        setEditing(false);
        setStep('personal');
      }
      setError('');
    } catch (err) {
      clearSession();
      setUser(null);
      setError(err.message || 'Please sign in again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    bootstrap();
  }, []);

  function patchPersonal(patch) {
    setProfile((prev) => ({ ...prev, personal: { ...prev.personal, ...patch } }));
  }

  function patchEdu(patch) {
    setProfile((prev) => ({
      ...prev,
      education: [{ ...(prev.education?.[0] || emptyProfile().education[0]), ...patch }],
    }));
  }

  function patchEe(patch) {
    setProfile((prev) => ({
      ...prev,
      equalEmployment: { ...prev.equalEmployment, ...patch },
    }));
  }

  function toggleCountry(code) {
    const cur = new Set(ee.workCountries || []);
    if (cur.has(code)) cur.delete(code);
    else cur.add(code);
    patchEe({ workCountries: [...cur] });
  }

  async function savePersonal(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const completedSteps = { ...profile.completedSteps, personal: true };
      await api.saveProfile({ personal, completedSteps });
      setProfile((p) => ({ ...p, completedSteps }));
      setStep('education');
      setToast('Personal info saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveEducation(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const education = [{ ...edu, endDate: edu.currentlyStudying ? '' : edu.endDate }];
      const completedSteps = { ...profile.completedSteps, education: true };
      await api.saveProfile({ education, completedSteps });
      setProfile((p) => ({ ...p, education, completedSteps }));
      setStep('equalEmployment');
      setToast('Education saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function finishProfile(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const completedSteps = { personal: true, education: true, equalEmployment: true };
      const res = await api.completeProfile({
        personal,
        education: profile.education,
        equalEmployment: ee,
        completedSteps,
      });
      setProfile(res.profile);
      setEditing(false);
      setStep('personal');
      setToast('Profile complete — ready to autofill');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const fullName = [personal.firstName, personal.middleName, personal.lastName]
    .filter(Boolean)
    .join(' ');
  const addressPill = [personal.addressLine, personal.postalCode, personal.city, personal.state]
    .filter(Boolean)
    .join(', ');
  const showView = profile.profileComplete && !editing;

  if (loading) {
    return (
      <div className="jr-profile-page">
        <p className="jr-loading">Loading your profile…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="jr-profile-page">
        <div className="jr-jobs-loading" aria-busy="true">
          <div className="skeleton" style={{ height: 180, borderRadius: 18 }} />
        </div>
      </div>
    );
  }

  return (
    <div className="jr-profile-page">
      {toast && <div className="jr-toast">{toast}</div>}

      <header className="jr-profile-head">
        <h1>PROFILE</h1>
        <div className="jr-profile-privacy">
          <span className="jr-privacy-face" aria-hidden="true">
            🙂
          </span>
          <span>Shared team profile — used by all members for autofill.</span>
        </div>
        <div className="jr-profile-user-bar">
          <span>{user.email}</span>
          <button
            type="button"
            className="jr-signout"
            onClick={async () => {
              try {
                await api.signout();
              } catch {
                /* ignore */
              }
              clearSession();
              setUser(null);
              navigate('/signin', { replace: true });
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="jr-profile-card">
        <div className="jr-profile-tabs" role="tablist">
          {STEPS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              className={step === s.id ? 'is-active' : ''}
              onClick={() => setStep(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {error && <p className="jr-error jr-error-pad">{error}</p>}

        {showView && step === 'personal' && (
          <div className="jr-profile-view">
            <div className="jr-profile-view-head">
              <h2>{fullName || 'Your name'}</h2>
              <button
                type="button"
                className="jr-edit-icon"
                aria-label="Edit personal info"
                onClick={() => setEditing(true)}
              >
                ✎
              </button>
            </div>
            <div className="jr-profile-pills">
              {addressPill ? (
                <span className="jr-pill">
                  <span aria-hidden="true">📍</span>
                  {addressPill}
                </span>
              ) : null}
              {personal.email ? (
                <span className="jr-pill">
                  <span aria-hidden="true">✉</span>
                  {personal.email}
                </span>
              ) : null}
              {personal.phone ? (
                <span className="jr-pill">
                  <span aria-hidden="true">☎</span>
                  {personal.phone}
                </span>
              ) : null}
            </div>

            <div className="jr-profile-subhead">
              <h3>Education</h3>
              <button
                type="button"
                className="jr-edit-icon"
                aria-label="Edit education"
                onClick={() => {
                  setStep('education');
                  setEditing(true);
                }}
              >
                ✎
              </button>
            </div>
            <div className="jr-edu-timeline">
              <div className="jr-edu-dot" aria-hidden="true" />
              <div className="jr-edu-body">
                <p className="jr-edu-dates">
                  {edu.startDate || '—'} to {edu.currentlyStudying ? 'Present' : edu.endDate || '—'}
                </p>
                <p className="jr-edu-school">{edu.schoolName || 'School not set'}</p>
                <p className="jr-edu-degree">
                  {[edu.degreeType, edu.major].filter(Boolean).join(' in ') || 'Degree not set'}
                </p>
              </div>
            </div>
          </div>
        )}

        {showView && step === 'education' && (
          <div className="jr-profile-view">
            <div className="jr-profile-subhead">
              <h3>Education</h3>
              <button
                type="button"
                className="jr-edit-icon"
                aria-label="Edit education"
                onClick={() => setEditing(true)}
              >
                ✎
              </button>
            </div>
            <div className="jr-edu-timeline">
              <div className="jr-edu-dot" aria-hidden="true" />
              <div className="jr-edu-body">
                <p className="jr-edu-dates">
                  {edu.startDate || '—'} to {edu.currentlyStudying ? 'Present' : edu.endDate || '—'}
                </p>
                <p className="jr-edu-school">{edu.schoolName || 'School not set'}</p>
                <p className="jr-edu-degree">
                  {[edu.degreeType, edu.major].filter(Boolean).join(' in ') || 'Degree not set'}
                  {edu.gpa ? ` · GPA ${edu.gpa}` : ''}
                </p>
              </div>
            </div>
          </div>
        )}

        {showView && step === 'equalEmployment' && (
          <div className="jr-profile-view">
            <div className="jr-profile-subhead">
              <h3>Equal Employment</h3>
              <button
                type="button"
                className="jr-edit-icon"
                aria-label="Edit equal employment"
                onClick={() => setEditing(true)}
              >
                ✎
              </button>
            </div>
            <dl className="jr-ee-view">
              {[
                [
                  'Countries where you want to work',
                  (ee.workCountries || [])
                    .map((c) => WORK_COUNTRIES.find((w) => w.code === c)?.label || c)
                    .join(', ') || '—',
                ],
                ['Are you a citizen of the United States?', ee.usCitizen || '—'],
                ['Do you have a disability?', ee.disability || '—'],
                ['Do you identify as LGBTQ+?', ee.lgbtq || '—'],
                ['What is your gender?', ee.gender || '—'],
                ['Are you a veteran?', ee.veteran || '—'],
                ['How would you identify your race?', ee.race || '—'],
                ['Are you Hispanic or Latino?', ee.hispanicLatino || '—'],
                ['How would you describe your sexual orientation?', ee.sexualOrientation || '—'],
                ['What Are Your Pronouns?', ee.pronouns || '—'],
              ].map(([q, a]) => (
                <div key={q} className="jr-ee-view-row">
                  <dt>{q}</dt>
                  <dd>
                    <span className="jr-ee-chip">{a}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {!showView && editing && (
          <div className="jr-profile-edit-banner">
            <span>{bubble}</span>
            {profile.profileComplete ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
                Done editing
              </button>
            ) : null}
          </div>
        )}

        {!showView && step === 'personal' && (
          <form className="jr-form-shell" onSubmit={savePersonal}>
            <div className="jr-scroll">
              <div className="jr-form-panel">
                <div className="jr-grid-3">
                  <Field label="First Name" required>
                    <input
                      required
                      value={personal.firstName}
                      onChange={(e) => patchPersonal({ firstName: e.target.value })}
                      placeholder="First name"
                    />
                  </Field>
                  <Field label="Middle Name">
                    <input
                      value={personal.middleName}
                      onChange={(e) => patchPersonal({ middleName: e.target.value })}
                      placeholder="Middle name"
                    />
                  </Field>
                  <Field label="Last Name" required>
                    <input
                      required
                      value={personal.lastName}
                      onChange={(e) => patchPersonal({ lastName: e.target.value })}
                      placeholder="Last name"
                    />
                  </Field>
                </div>

                <Field label="Email" required>
                  <input
                    type="email"
                    required
                    value={personal.email}
                    onChange={(e) => patchPersonal({ email: e.target.value })}
                    placeholder="you@example.com"
                  />
                </Field>

                <div className="jr-grid-2">
                  <Field label="Phone Type">
                    <Select
                      value={personal.phoneType}
                      onChange={(v) => patchPersonal({ phoneType: v })}
                      options={OPT.phoneType}
                    />
                  </Field>
                  <Field label="Phone" required>
                    <input
                      required
                      value={personal.phone}
                      onChange={(e) => patchPersonal({ phone: e.target.value })}
                      placeholder="+1 555-000-0000"
                    />
                  </Field>
                </div>

                <Field label="Address Line" required>
                  <input
                    required
                    value={personal.addressLine}
                    onChange={(e) => patchPersonal({ addressLine: e.target.value })}
                    placeholder="Enter your current address"
                  />
                </Field>

                <div className="jr-grid-3">
                  <Field label="Country/Region" required>
                    <input
                      required
                      value={personal.country}
                      onChange={(e) => patchPersonal({ country: e.target.value })}
                    />
                  </Field>
                  <Field label="State/Province" required>
                    <input
                      required
                      value={personal.state}
                      onChange={(e) => patchPersonal({ state: e.target.value })}
                    />
                  </Field>
                  <Field label="City" required>
                    <input
                      required
                      value={personal.city}
                      onChange={(e) => patchPersonal({ city: e.target.value })}
                    />
                  </Field>
                </div>

                <div className="jr-grid-2">
                  <Field label="County">
                    <input
                      value={personal.county}
                      onChange={(e) => patchPersonal({ county: e.target.value })}
                      placeholder="County"
                    />
                  </Field>
                  <Field label="Postal Code" required>
                    <input
                      required
                      value={personal.postalCode}
                      onChange={(e) => patchPersonal({ postalCode: e.target.value })}
                      placeholder="Postal code"
                    />
                  </Field>
                </div>

                <div className="jr-section-title">Links</div>
                <Field label="LinkedIn URL">
                  <input
                    value={personal.linkedinUrl}
                    onChange={(e) => patchPersonal({ linkedinUrl: e.target.value })}
                    placeholder="https://linkedin.com/in/…"
                  />
                </Field>
                <Field label="GitHub URL">
                  <input
                    value={personal.githubUrl}
                    onChange={(e) => patchPersonal({ githubUrl: e.target.value })}
                    placeholder="https://github.com/…"
                  />
                </Field>
                <Field label="Portfolio URL">
                  <input
                    value={personal.portfolioUrl}
                    onChange={(e) => patchPersonal({ portfolioUrl: e.target.value })}
                    placeholder="https://…"
                  />
                </Field>
              </div>
            </div>
            <div className="jr-footer">
              <button type="submit" className="jr-cta" disabled={saving}>
                {saving ? 'Saving…' : 'Next'}
              </button>
            </div>
          </form>
        )}

        {!showView && step === 'education' && (
          <form className="jr-form-shell" onSubmit={saveEducation}>
            <div className="jr-scroll">
              <div className="jr-form-panel">
                <div className="jr-edu-card">
                  <div className="jr-edu-head">Education 1</div>
                  <Field label="School Name" required>
                    <input
                      required
                      value={edu.schoolName}
                      onChange={(e) => patchEdu({ schoolName: e.target.value })}
                      placeholder="University name"
                    />
                  </Field>
                  <Field label="Major" required>
                    <input
                      required
                      value={edu.major}
                      onChange={(e) => patchEdu({ major: e.target.value })}
                      placeholder="Computer Science"
                    />
                  </Field>
                  <Field label="Degree Type" required>
                    <input
                      required
                      value={edu.degreeType}
                      onChange={(e) => patchEdu({ degreeType: e.target.value })}
                      placeholder="Bachelor's Degree"
                    />
                  </Field>
                  <Field label="GPA">
                    <input
                      value={edu.gpa}
                      onChange={(e) => patchEdu({ gpa: e.target.value })}
                      placeholder="Optional"
                    />
                  </Field>
                  <div className="jr-grid-2">
                    <Field label="Start Date">
                      <input
                        type="month"
                        value={edu.startDate}
                        onChange={(e) => patchEdu({ startDate: e.target.value })}
                      />
                    </Field>
                    <Field label="End Date">
                      <input
                        type="month"
                        value={edu.endDate}
                        disabled={!!edu.currentlyStudying}
                        onChange={(e) => patchEdu({ endDate: e.target.value })}
                      />
                    </Field>
                  </div>
                  <label className="jr-check">
                    <input
                      type="checkbox"
                      checked={!!edu.currentlyStudying}
                      onChange={(e) => patchEdu({ currentlyStudying: e.target.checked })}
                    />
                    <span>I currently study here</span>
                  </label>
                </div>
              </div>
            </div>
            <div className="jr-footer jr-footer-split">
              <button type="button" className="jr-btn-back" onClick={() => setStep('personal')}>
                Back
              </button>
              <button type="submit" className="jr-cta" disabled={saving}>
                {saving ? 'Saving…' : 'Next'}
              </button>
            </div>
          </form>
        )}

        {!showView && step === 'equalEmployment' && (
          <form className="jr-form-shell" onSubmit={finishProfile}>
            <div className="jr-scroll">
              <div className="jr-form-panel">
                <div className="jr-block">
                  <div className="jr-block-title">Countries where you want to work?</div>
                  <div className="jr-flags">
                    {WORK_COUNTRIES.map((c) => {
                      const on = (ee.workCountries || []).includes(c.code);
                      return (
                        <button
                          key={c.code}
                          type="button"
                          className={`jr-flag ${on ? 'is-on' : ''}`}
                          onClick={() => toggleCountry(c.code)}
                          title={c.label}
                        >
                          <span className="jr-flag-emoji">{c.flag}</span>
                          <span className="jr-flag-code">{c.code}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {(ee.workCountries || []).includes('US') && (
                  <div className="jr-block">
                    <div className="jr-block-title">Are you a citizen of the United States?</div>
                    <div className="jr-yesno">
                      {['Yes', 'No'].map((v) => (
                        <button
                          key={v}
                          type="button"
                          className={`jr-yesno-btn ${ee.usCitizen === v ? 'is-on' : ''}`}
                          onClick={() => patchEe({ usCitizen: v })}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="jr-ee-list">
                  <div className="jr-ee-row">
                    <span>
                      Do you have a disability?<em>*</em>
                    </span>
                    <Select
                      required
                      value={ee.disability}
                      onChange={(v) => patchEe({ disability: v })}
                      options={OPT.yesNoDecline}
                    />
                  </div>
                  <div className="jr-ee-row">
                    <span>
                      Are you a veteran?<em>*</em>
                    </span>
                    <Select
                      required
                      value={ee.veteran}
                      onChange={(v) => patchEe({ veteran: v })}
                      options={OPT.yesNoDecline}
                    />
                  </div>
                  <div className="jr-ee-row">
                    <span>
                      What is your gender?<em>*</em>
                    </span>
                    <Select
                      required
                      value={ee.gender}
                      onChange={(v) => patchEe({ gender: v })}
                      options={OPT.gender}
                    />
                  </div>
                  <div className="jr-ee-row">
                    <span>
                      Do you identify as LGBTQ+?<em>*</em>
                    </span>
                    <Select
                      required
                      value={ee.lgbtq}
                      onChange={(v) => patchEe({ lgbtq: v })}
                      options={OPT.yesNoDecline}
                    />
                  </div>
                  <div className="jr-ee-row">
                    <span>
                      How would you identify your race?<em>*</em>
                    </span>
                    <Select
                      required
                      value={ee.race}
                      onChange={(v) => patchEe({ race: v })}
                      options={OPT.race}
                    />
                  </div>
                  <div className="jr-ee-row">
                    <span>
                      Are you Hispanic or Latino?<em>*</em>
                    </span>
                    <Select
                      required
                      value={ee.hispanicLatino}
                      onChange={(v) => patchEe({ hispanicLatino: v })}
                      options={OPT.yesNoDecline}
                    />
                  </div>
                  <div className="jr-ee-row">
                    <span>
                      Sexual orientation?<em>*</em>
                    </span>
                    <Select
                      required
                      value={ee.sexualOrientation}
                      onChange={(v) => patchEe({ sexualOrientation: v })}
                      options={OPT.orientation}
                    />
                  </div>
                  <div className="jr-ee-row">
                    <span>What are your pronouns?</span>
                    <Select
                      value={ee.pronouns}
                      onChange={(v) => patchEe({ pronouns: v })}
                      options={OPT.pronouns}
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="jr-footer jr-footer-split">
              <button type="button" className="jr-btn-back" onClick={() => setStep('education')}>
                Back
              </button>
              <button type="submit" className="jr-cta" disabled={saving}>
                {saving ? 'Saving…' : 'Finish'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
