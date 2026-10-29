/**
 * King Star — Jobright-style account setup + profile wizard.
 * Steps: Personal → Education → Equal Employment (skips Work Experience & Skill).
 */
(function () {
  const HS = (window.HiddenStar = window.HiddenStar || {});

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

  const PROFILE_STEPS = [
    { id: 'personal', label: 'Personal' },
    { id: 'education', label: 'Education' },
    { id: 'equalEmployment', label: 'Equal Employment' },
  ];

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

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function selectHtml(name, options, value, required) {
    const opts = options
      .map(
        (o) =>
          `<option value="${escapeHtml(o)}" ${value === o ? 'selected' : ''}>${escapeHtml(o)}</option>`
      )
      .join('');
    return `<select name="${name}" ${required ? 'required' : ''}>
      <option value="">Select</option>${opts}
    </select>`;
  }

  function renderStepper(activeId) {
    const activeIdx = PROFILE_STEPS.findIndex((s) => s.id === activeId);
    return `
      <div class="hs-wizard-steps" role="list">
        ${PROFILE_STEPS.map((s, i) => {
          const done = i < activeIdx;
          const active = s.id === activeId;
          return `<div class="hs-wizard-step ${done ? 'is-done' : ''} ${active ? 'is-active' : ''}" role="listitem">
            <span class="hs-wizard-num">${done ? '✓' : i + 1}</span>
            <span class="hs-wizard-label">${escapeHtml(s.label)}</span>
          </div>`;
        }).join('<div class="hs-wizard-line" aria-hidden="true"></div>')}
      </div>`;
  }

  function renderSetupHome({ user, profileComplete, completedSteps }) {
    const accountDone = !!user;
    const profileDone = !!profileComplete;
    const canStart = accountDone && profileDone;
    return `
      <div class="hs-setup">
        <div class="hs-setup-hero">
          <div class="hs-setup-bolt" aria-hidden="true">
            <svg viewBox="0 0 48 48" width="40" height="40" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M27 4L12 26h10l-2 18 17-24H27l0-16z" fill="#111" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>
          </div>
          <h2 class="hs-setup-title">Autofill with King Star</h2>
          <p class="hs-setup-sub">Complete your setup to start autofilling applications in one click.</p>
        </div>
        <div class="hs-checklist">
          <div class="hs-check-item ${accountDone ? 'is-done' : ''}">
            <div class="hs-check-left">
              <span class="hs-check-num">${accountDone ? '✓' : '1'}</span>
              <div class="hs-check-copy">
                <div class="hs-check-title">Set up a King Star account</div>
                <div class="hs-check-desc">${accountDone ? escapeHtml(user.email) : 'Sign in with your King Star account'}</div>
              </div>
            </div>
            ${
              accountDone
                ? `<button type="button" class="hs-check-done" data-action="signout" title="Sign out">✓</button>`
                : `<button type="button" class="hs-check-go" data-action="open-auth">GO</button>`
            }
          </div>
          <div class="hs-check-item ${profileDone ? 'is-done' : ''} ${!accountDone ? 'is-locked' : ''}">
            <div class="hs-check-left">
              <span class="hs-check-num">${profileDone ? '✓' : '2'}</span>
              <div class="hs-check-copy">
                <div class="hs-check-title">Complete your profile details</div>
                <div class="hs-check-desc">${
                  profileDone
                    ? 'Personal, Education, Equal Employment'
                    : accountDone
                      ? 'Opens in King Star web app'
                      : 'Finish step 1 first'
                }</div>
              </div>
            </div>
            ${
              profileDone
                ? `<button type="button" class="hs-check-done" data-action="edit-profile" title="Edit profile">✓</button>`
                : `<button type="button" class="hs-check-go" data-action="open-profile" ${!accountDone ? 'disabled' : ''}>GO</button>`
            }
          </div>
        </div>
        <button type="button" class="hs-start-apply ${canStart ? 'is-ready' : 'is-locked'}" data-action="start-applying" ${canStart ? '' : 'disabled'}>
          <span class="hs-start-apply-icon" aria-hidden="true">
            ${
              canStart
                ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M5 12h12M13 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
                : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
            }
          </span>
          <span class="hs-start-apply-copy">
            <span class="hs-start-apply-label">Start Applying</span>
            <span class="hs-start-apply-hint">${
              canStart
                ? 'Autofill is ready — open a job form'
                : !accountDone
                  ? 'Finish account setup to unlock'
                  : 'Complete your profile to unlock'
            }</span>
          </span>
        </button>
        ${
          accountDone && !profileDone
            ? `<p class="hs-setup-hint">Profile progress: ${
                ['personal', 'education', 'equalEmployment']
                  .filter((k) => completedSteps?.[k])
                  .length
              }/3 sections</p>`
            : ''
        }
      </div>`;
  }

  function renderAuth({ mode = 'signin' } = {}) {
    return `
      <div class="hs-auth">
        <button type="button" class="hs-back" data-action="back-setup">
          <span class="hs-back-arrow" aria-hidden="true">←</span> Back to setup
        </button>

        <div class="hs-auth-hero">
          <div class="hs-auth-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="22" height="22" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6.2 18.2c3.4-1.2 6.6-4.1 8.8-7.6 1.1 3.4 3.2 6.2 6.4 8.1-2.8.4-5.2 1.6-7 3.6-1.9-1.7-4.7-2.9-8.2-4.1z" fill="#fff" stroke="#0b3d32" stroke-width="1.2" stroke-linejoin="round"/>
              <path d="M21.4 10.2c1.6 2.2 2.2 4.4 1.8 6.5 2.4-1.1 4.2-2.8 5.2-5.1-2.3.1-4.6-.2-7-1.4z" fill="#fff" stroke="#0b3d32" stroke-width="1.2" stroke-linejoin="round"/>
            </svg>
          </div>
          <h2 class="hs-auth-title">Welcome back</h2>
          <p class="hs-auth-sub">Sign in to unlock autofill with your saved profile.</p>
        </div>

        <form class="hs-auth-form hs-auth-card" data-auth-form="signin">
          <label class="hs-field">
            <span>Email</span>
            <input name="email" type="email" required autocomplete="email" placeholder="you@example.com" value="anthonyfait.digital@gmail.com" />
          </label>
          <label class="hs-field">
            <span>Password</span>
            <input name="password" type="password" required minlength="6" autocomplete="current-password" placeholder="Your password" />
          </label>
          <button type="submit" class="hs-btn hs-auth-submit">
            Sign in
          </button>
        </form>

        <p class="hs-auth-fine">Signup is disabled. Use your existing King Star account.</p>
      </div>`;
  }

  function renderPersonal(p) {
    return `
      <div class="hs-wizard" data-wizard-step="personal">
        ${renderStepper('personal')}
        <div class="hs-bubble">🎉 Great! Let's get started with your basic info.</div>
        <form class="hs-profile-form" data-profile-form="personal">
          <div class="hs-grid-3">
            <label class="hs-field"><span>First Name *</span>
              <input name="firstName" required value="${escapeHtml(p.firstName)}" />
            </label>
            <label class="hs-field"><span>Middle Name</span>
              <input name="middleName" value="${escapeHtml(p.middleName)}" placeholder="Middle Name" />
            </label>
            <label class="hs-field"><span>Last Name *</span>
              <input name="lastName" required value="${escapeHtml(p.lastName)}" />
            </label>
          </div>
          <label class="hs-field"><span>Email *</span>
            <input name="email" type="email" required value="${escapeHtml(p.email)}" />
          </label>
          <div class="hs-grid-2">
            <label class="hs-field"><span>Phone Type</span>
              ${selectHtml('phoneType', OPT.phoneType, p.phoneType, false)}
            </label>
            <label class="hs-field"><span>Phone *</span>
              <input name="phone" required value="${escapeHtml(p.phone)}" placeholder="+1 555-000-0000" />
            </label>
          </div>
          <label class="hs-field"><span>Address Line *</span>
            <input name="addressLine" required value="${escapeHtml(p.addressLine)}" placeholder="Enter your current address" />
          </label>
          <div class="hs-grid-3">
            <label class="hs-field"><span>Country/Region *</span>
              <input name="country" required value="${escapeHtml(p.country)}" />
            </label>
            <label class="hs-field"><span>State/Province *</span>
              <input name="state" required value="${escapeHtml(p.state)}" />
            </label>
            <label class="hs-field"><span>City *</span>
              <input name="city" required value="${escapeHtml(p.city)}" />
            </label>
          </div>
          <div class="hs-grid-2">
            <label class="hs-field"><span>County</span>
              <input name="county" value="${escapeHtml(p.county)}" placeholder="Enter your current county" />
            </label>
            <label class="hs-field"><span>Postal Code *</span>
              <input name="postalCode" required value="${escapeHtml(p.postalCode)}" placeholder="Enter postal code" />
            </label>
          </div>
          <label class="hs-field"><span>LinkedIn URL</span>
            <input name="linkedinUrl" value="${escapeHtml(p.linkedinUrl)}" placeholder="Enter your LinkedIn url" />
          </label>
          <label class="hs-field"><span>GitHub URL</span>
            <input name="githubUrl" value="${escapeHtml(p.githubUrl)}" placeholder="Enter your GitHub url" />
          </label>
          <label class="hs-field"><span>Portfolio URL</span>
            <input name="portfolioUrl" value="${escapeHtml(p.portfolioUrl)}" placeholder="Enter your Portfolio url" />
          </label>
          <button type="submit" class="hs-btn hs-accent hs-btn-block">Next</button>
        </form>
      </div>`;
  }

  function renderEducation(list) {
    const edu = list?.[0] || emptyProfile().education[0];
    return `
      <div class="hs-wizard" data-wizard-step="education">
        ${renderStepper('education')}
        <div class="hs-bubble">Next, please review and confirm your education history.</div>
        <form class="hs-profile-form" data-profile-form="education">
          <div class="hs-edu-card">
            <div class="hs-edu-head">Education 1</div>
            <label class="hs-field"><span>School Name *</span>
              <input name="schoolName" required value="${escapeHtml(edu.schoolName)}" />
            </label>
            <label class="hs-field"><span>Major *</span>
              <input name="major" required value="${escapeHtml(edu.major)}" />
            </label>
            <label class="hs-field"><span>Degree Type *</span>
              <input name="degreeType" required value="${escapeHtml(edu.degreeType)}" placeholder="Bachelor's Degree" />
            </label>
            <label class="hs-field"><span>GPA</span>
              <input name="gpa" value="${escapeHtml(edu.gpa)}" />
            </label>
            <div class="hs-grid-2">
              <label class="hs-field"><span>Start Date</span>
                <input name="startDate" type="month" value="${escapeHtml(edu.startDate)}" />
              </label>
              <label class="hs-field"><span>End Date</span>
                <input name="endDate" type="month" value="${escapeHtml(edu.endDate)}" ${
                  edu.currentlyStudying ? 'disabled' : ''
                } />
              </label>
            </div>
            <label class="hs-check-inline">
              <input type="checkbox" name="currentlyStudying" ${edu.currentlyStudying ? 'checked' : ''} />
              <span>I currently study here</span>
            </label>
          </div>
          <div class="hs-wizard-nav">
            <button type="button" class="hs-btn hs-btn-ghost" data-action="wizard-back" data-to="personal">Back</button>
            <button type="submit" class="hs-btn hs-accent">Next</button>
          </div>
        </form>
      </div>`;
  }

  function renderEqualEmployment(ee) {
    const selected = new Set(ee.workCountries || []);
    return `
      <div class="hs-wizard" data-wizard-step="equalEmployment">
        ${renderStepper('equalEmployment')}
        <div class="hs-bubble">Last step! This information is only used to help autofill applications and will never be shared with anyone.</div>
        <form class="hs-profile-form" data-profile-form="equalEmployment">
          <div class="hs-field">
            <span>Countries where you want to work?</span>
            <div class="hs-flags">
              ${WORK_COUNTRIES.map(
                (c) => `
                <label class="hs-flag ${selected.has(c.code) ? 'is-on' : ''}" title="${escapeHtml(c.label)}">
                  <input type="checkbox" name="workCountries" value="${c.code}" ${
                    selected.has(c.code) ? 'checked' : ''
                  } hidden />
                  <span class="hs-flag-emoji">${c.flag}</span>
                  <span class="hs-flag-code">${c.code}</span>
                </label>`
              ).join('')}
            </div>
          </div>
          ${
            selected.has('US')
              ? `<div class="hs-field">
                  <span>Are you a citizen of the United States?</span>
                  <div class="hs-toggle-row">
                    <label class="hs-toggle ${ee.usCitizen === 'Yes' ? 'is-on' : ''}">
                      <input type="radio" name="usCitizen" value="Yes" ${
                        ee.usCitizen === 'Yes' ? 'checked' : ''
                      } /> Yes
                    </label>
                    <label class="hs-toggle ${ee.usCitizen === 'No' ? 'is-on' : ''}">
                      <input type="radio" name="usCitizen" value="No" ${
                        ee.usCitizen === 'No' ? 'checked' : ''
                      } /> No
                    </label>
                  </div>
                </div>`
              : ''
          }
          <label class="hs-field"><span>Do you have a disability? *</span>
            ${selectHtml('disability', OPT.yesNoDecline, ee.disability, true)}
          </label>
          <label class="hs-field"><span>Are you a veteran? *</span>
            ${selectHtml('veteran', OPT.yesNoDecline, ee.veteran, true)}
          </label>
          <label class="hs-field"><span>What is your gender? *</span>
            ${selectHtml('gender', OPT.gender, ee.gender, true)}
          </label>
          <label class="hs-field"><span>Do you identify as LGBTQ+? *</span>
            ${selectHtml('lgbtq', OPT.yesNoDecline, ee.lgbtq, true)}
          </label>
          <label class="hs-field"><span>How would you identify your race? *</span>
            ${selectHtml('race', OPT.race, ee.race, true)}
          </label>
          <label class="hs-field"><span>Are you Hispanic or Latino? *</span>
            ${selectHtml('hispanicLatino', OPT.yesNoDecline, ee.hispanicLatino, true)}
          </label>
          <label class="hs-field"><span>How would you describe your sexual orientation? *</span>
            ${selectHtml('sexualOrientation', OPT.orientation, ee.sexualOrientation, true)}
          </label>
          <label class="hs-field"><span>What Are Your Pronouns?</span>
            ${selectHtml('pronouns', OPT.pronouns, ee.pronouns, false)}
          </label>
          <div class="hs-wizard-nav">
            <button type="button" class="hs-btn hs-btn-ghost" data-action="wizard-back" data-to="education">Back</button>
            <button type="submit" class="hs-btn hs-accent">Finish</button>
          </div>
        </form>
      </div>`;
  }

  function formToObject(form) {
    const fd = new FormData(form);
    const obj = {};
    for (const [k, v] of fd.entries()) {
      if (k === 'workCountries') {
        if (!obj.workCountries) obj.workCountries = [];
        obj.workCountries.push(v);
      } else if (k === 'currentlyStudying') {
        obj.currentlyStudying = true;
      } else {
        obj[k] = v;
      }
    }
    if (form.querySelector('[name="currentlyStudying"]') && !obj.currentlyStudying) {
      obj.currentlyStudying = false;
    }
    return obj;
  }

  HS.Setup = {
    emptyProfile,
    renderSetupHome,
    renderAuth,
    renderPersonal,
    renderEducation,
    renderEqualEmployment,
    formToObject,
    PROFILE_STEPS,
  };
})();
