/**
 * Detect application form fields, fill them, and capture filled answers.
 */
(function () {
  const HS = (window.HiddenStar = window.HiddenStar || {});
  // Also listed in the all-frames entry (for embedded application forms): load once per frame
  if (HS.__autofillLoaded) return;
  HS.__autofillLoaded = true;

  const SKIP_TYPES = new Set([
    'hidden',
    'submit',
    'button',
    'image',
    'file',
    'reset',
  ]);

  function normalizeLabel(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s*\*+\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

    /**
   * ATS required marker — any "*" on a prompt marks an application question
   * (even when helper copy follows, or * sits in its own span).
   */
  function hasRequiredAsterisk(text) {
    const original = String(text || '');
    if (!original.includes('*')) return false;
    if (/\*\s*<\/?\w/i.test(original)) return true;
    // Per-line: "Location *" / "…question? *" then helper text below still counts
    const lines = original
      .replace(/\u00a0/g, ' ')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.some((l) => /\*\s*$/.test(l) || /\?\s*\*/.test(l) || /\w\s*\*\s*$/.test(l))) {
      return true;
    }
    if (lines.some((l) => /\w.+\*/.test(l) && l.length < 400 && !/^[\u2022·•]/.test(l))) {
      return true;
    }
    // Same node, collapsed whitespace: "…status)? * We are unable to hire…"
    const flat = original.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\*\s*$/.test(flat)) return true;
    if (/\?\s*\*\s+\S/.test(flat)) return true;
    if (/\b[\w)\]'"]+\s*\*\s+(we are|note|please|this |for this|candidates|required)\b/i.test(flat)) {
      return true;
    }
    // Short titles: "Location *", "City*", "Phone *"
    if (flat.length <= 80 && /\S\s*\*\s*$/.test(flat)) return true;
    if (flat.length <= 80 && /\S\*\s*$/.test(flat)) return true;
    return false;
  }
  /** First question-like line from a label that may include helper text after *. */
  function questionTextFromAsteriskLabel(text) {
    const original = String(text || '');
    const lines = original
      .replace(/\u00a0/g, ' ')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const starred = lines.find((l) => /\*\s*$/.test(l));
    if (starred) return normalizeLabel(starred);
    const flat = original.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const m = flat.match(/^(.+?\*)\s+(we are|note|please|this |for this|candidates|required)\b(.*)$/i);
    if (m) return normalizeLabel(m[1]);
    const m2 = flat.match(/^(.+\?\s*\*)\s+/);
    if (m2) return normalizeLabel(m2[1]);
    return normalizeLabel(original);
  }

  /** Real field prompts that happen to start with "Please …" (not helper tips). */
  function isPleaseQuestionPrompt(text) {
    const t = normalizeLabel(text);
    return /^please\s+(identify|select|choose|indicate|specify|provide|enter|list|describe|tell|share|confirm|state)\b/i.test(
      t
    );
  }

  /** ATS note under a real prompt — never treat as the question title. */
  function isAtsHelperNote(text) {
    const t = normalizeLabel(text);
    if (!t) return true;
    // Ashby-style helper lines that sit between the ?* prompt and Yes/No buttons
    if (
      /if not applicable[, ]+select no\.?/i.test(t) ||
      /select no if not applicable/i.test(t) ||
      /we may provide (immigration|sponsorship)/i.test(t) ||
      /immigration and sponsorship support/i.test(t) ||
      /based on their unique circumstances/i.test(t)
    ) {
      return true;
    }
    if (
      /we are unable to hire|unable to (sponsor|hire)|visa candidates for this role|this role does not (offer|provide) sponsorship|candidates must be authorized|no sponsorship (is )?available|will not sponsor/i.test(
        t
      )
    ) {
      return true;
    }
    // Short non-question notes under a field
    if (
      t.length < 120 &&
      !/\?/.test(t) &&
      /^(we |this |note[:\s]|please note|important[:\s]|only |for this role)/i.test(t)
    ) {
      return true;
    }
    return false;
  }

  /** Helper / description copy under a real question (not a fillable prompt). */
  function isHelperText(text) {
    const t = normalizeLabel(text);
    if (!t) return true;
    if (isAtsHelperNote(text)) return true;
    // Required asterisk / interrogative prompts are never helper copy
    if (hasRequiredAsterisk(text)) return false;
    if (/\?/.test(t) && t.length >= 12) return false;
    // "Please identify your race" / "Please select your gender" are real questions
    if (isPleaseQuestionPrompt(t)) return false;
    if (
      /^(please|note[:\s]|tip[:\s]|hint[:\s]|reference|see (the|our|below)|e\.g\.|eg\.|for example|optional|required field)/i.test(
        t
      )
    ) {
      return true;
    }
    if (
      /^(please\s+)?(reference|refer to|see|check|review|read)\b/i.test(t) &&
      !/^(are|will|do|does|have|has|is|can|how|what|why)\b/i.test(t)
    ) {
      return true;
    }
    // Short instructional lines without interrogative shape
    if (
      t.length <= 90 &&
      !/\?/.test(t) &&
      !/^(are|will|do|does|have|has|is|can|how|what|why|when|where|who|tell|describe|explain|share|walk|please\s+(identify|select|choose))\b/i.test(
        t
      ) &&
      /^(please|note|tip|hint|this field|enter |type |select |choose |if not )/i.test(t)
    ) {
      return true;
    }
    return false;
  }

  function looksLikeQuestion(text) {
    const raw = String(text || '');
    const required = hasRequiredAsterisk(raw);
    const t = normalizeLabel(text);
    if (!t || t.length < 2) return false;
    if (isAtsHelperNote(raw) || isAtsHelperNote(t)) return false;
    // "Location *" / any required field title → always a question
    if (required && !isEeSectionHeader(t) && !isLikelyOptionLabel(t)) return true;
    if (isHelperText(t)) return false;
    if (/\?/.test(t)) return true;
    if (isPleaseQuestionPrompt(t)) return true;
    if (
      /^(are|will|do|does|did|have|has|is|can|could|would|should|how|what|why|when|where|who|which|tell|describe|explain|share|walk|list|provide|please)\b/i.test(
        t
      )
    ) {
      return true;
    }
    if (
      /name|email|phone|linkedin|resume|cv|company|title|address|city|country|location|race|gender|ethnicity|veteran|disability/i.test(
        t
      )
    ) {
      return true;
    }
    // Short canonical field titles (even without *)
    if (
      /^(location|city|state|country|address|phone|email|linkedin|github|portfolio|website|name|first name|last name)$/i.test(
        t
      )
    ) {
      return true;
    }
    return t.length >= 12;
  }

  /** EEO / legal section banners — not the actual Gender/Race/Veteran question. */
  function isEeSectionHeader(text) {
    const t = normalizeLabel(text);
    if (!t) return false;
    if (/u\.?\s*s\.?\s*equal\s+employment|equal\s+employment\s+opportunity|eeo\b|voluntary\s+self[- ]?identif/i.test(t)) {
      return true;
    }
    if (/government\s+record\s+keeping|invitation\s+to\s+self[- ]?identify|ofccp|compliance\s+survey/i.test(t)) {
      return true;
    }
    if (
      /self[- ]?identification of (veteran|disability|race|gender)|veteran status\s*\(.*voluntary|completion is voluntary/i.test(
        t
      )
    ) {
      return true;
    }
    // Long legal blurbs under EEO
    if (t.length > 90 && /equal\s+opportunity|self[- ]?identif|race.?ethnicity|gender\s+identity/i.test(t)) {
      return true;
    }
    return false;
  }

  /** Common radio option text mistaken for the question label. */
  function isLikelyOptionLabel(text) {
    const t = normalizeLabel(text);
    if (!t) return false;
    if (t.length > 160) return false;
    if (
      /^(male|female|man|woman|non[- ]?binary|other|yes|no|n\/a)$/i.test(t)
    ) {
      return true;
    }
    if (/^decline\s+to\s+(self[- ]?identify|state|answer|say)/i.test(t)) return true;
    if (/^prefer\s+not\s+to\s+(say|answer|self[- ]?identify)/i.test(t)) return true;
    if (
      /^(hispanic\s+or\s+latino|white|black|asian|american\s+indian|native\s+hawaiian|two\s+or\s+more\s+races)/i.test(
        t
      )
    ) {
      return true;
    }
    if (/\(not\s+hispanic\s+or\s+latino\)/i.test(t)) return true;
    // OFCCP veteran option rows (not the "Veteran Status" field title)
    if (
      /i identify as one or more of the classifications of (a )?protected veteran/i.test(t) ||
      /^i am not a protected veteran/i.test(t) ||
      /decline to self-identify for protected veteran/i.test(t)
    ) {
      return true;
    }
    return false;
  }

  function questionScore(node, text) {
    let score = 0;
    const raw = String(text || '');
    const t = normalizeLabel(text);
    if (!t) return -100;
    if (isEeSectionHeader(t)) return -80;
    if (isLikelyOptionLabel(t)) return -60;
    if (isAtsHelperNote(raw) || isAtsHelperNote(t)) return -100;
    if (isHelperText(raw) && !hasRequiredAsterisk(raw) && !/\?/.test(t)) return -80;
    // Required asterisk = strong signal this is the field prompt
    if (hasRequiredAsterisk(raw) || hasRequiredAsterisk(node?.innerText || '')) score += 55;
    if (/\?/.test(t)) score += 45;
    if (looksLikeQuestion(raw) || looksLikeQuestion(t)) score += 20;
    if (/^(are|will|do|does|have|has|is|can|how|what|why|when|where|who)\b/i.test(t)) score += 15;
    // Canonical short field titles
    if (
      /^(gender|race|ethnicity|race\/ethnicity|veteran(\s+status)?|disability(\s+status)?|pronouns?|location)$/i.test(
        t
      )
    ) {
      score += 55;
    }
    if (
      /^(what is your gender|how would you identify your race|gender identity|please identify your race|please select your race|please select your gender)\b/i.test(
        t
      )
    ) {
      score += 50;
    }
    if (/identify your race|select your race|your race\b/i.test(t)) score += 40;
    const tag = (node?.tagName || '').toLowerCase();
    if (tag === 'label' || tag === 'legend') score += 30;
    if (/^h[1-6]$/.test(tag)) score += 8; // headings often section banners, not field labels
    const cls = `${node?.className || ''} ${node?.getAttribute?.('data-testid') || ''}`;
    if (/question|label|title|prompt|field-label/i.test(cls)) score += 25;
    if (/description|helper|hint|subtitle|caption|support|help-text|instruction|banner/i.test(cls)) {
      score -= 50;
    }
    try {
      const weight = Number(window.getComputedStyle(node).fontWeight) || 400;
      if (weight >= 600) score += 8;
    } catch {
      /* ignore */
    }
    // Prefer real prompts: don't let short helpers beat long ?* questions
    if (/\?/.test(t) || hasRequiredAsterisk(raw)) {
      if (t.length >= 20 && t.length <= 280) score += 10;
    } else if (t.length >= 4 && t.length <= 40) {
      score += 4; // weak bonus for short non-question titles only
    }
    if (t.length > 320) score -= 20;
    return score;
  }

  function pickBestQuestionText(candidates, { minLen = 2, maxLen = 500 } = {}) {
    let best = null;
    let bestScore = -Infinity;
    for (const { node, text } of candidates) {
      const raw = String(text || '');
      const t = normalizeLabel(text);
      const required = hasRequiredAsterisk(raw) || hasRequiredAsterisk(node?.innerText || '');
      const effectiveMin = required ? Math.min(minLen, 2) : minLen;
      if (!t || t.length < effectiveMin || t.length > maxLen) continue;
      if (/^(type here|select|choose|yes|no)$/i.test(t)) continue;
      if (/^yes\s*no$/i.test(t)) continue;
      if (isEeSectionHeader(t) || isLikelyOptionLabel(t)) continue;
      // Never pick grey helper lines under a ?* prompt as the question title
      if (isAtsHelperNote(raw) || isAtsHelperNote(t)) continue;
      if (isHelperText(raw) && !/\?/.test(t) && !required) continue;
      const score = questionScore(node, raw);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    // Require a non-helper pick; reject weak helper-only matches
    if (bestScore < 0) return '';
    return best || '';
  }

  /** Number of distinct fields under root (a radio/checkbox group counts once). */
  function distinctFieldCount(root) {
    const keys = new Set();
    root.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach((c) => {
      const t = (c.type || '').toLowerCase();
      keys.add((t === 'radio' || t === 'checkbox') && c.name ? `group:${c.name}` : c);
    });
    return keys.size;
  }

  /** Floating MUI / outlined-select labels live inside the same box as the control. */
  function floatingLabelNear(el) {
    const wrap =
      el.closest(
        '.MuiFormControl-root, .MuiTextField-root, [class*="FormControl"], [class*="form-control"], [class*="field"], label, [class*="select"], [class*="Select"]'
      ) || el.parentElement;
    if (!wrap) return '';
    // A box holding several fields (a whole form, a row of inputs) can't say which label is ours
    if (distinctFieldCount(wrap) > 1) return '';
    const nodes = wrap.querySelectorAll(
      'label, legend, [class*="InputLabel"], [class*="FormLabel"], [class*="label"], legend'
    );
    for (const lab of nodes) {
      // A <label for="x"> belongs to control x, never to a neighbour
      if (lab.tagName === 'LABEL' && lab.htmlFor && lab.htmlFor !== el.id) continue;
      const clone = lab.cloneNode(true);
      clone.querySelectorAll('input, select, textarea, button, svg').forEach((n) => n.remove());
      const t = normalizeLabel(clone.innerText || clone.textContent || '');
      if (!t || t.length < 2 || t.length > 160) continue;
      if (/^(select\.{0,3}|choose|type here)$/i.test(t)) continue;
      const raw = lab.innerText || lab.textContent || '';
      if (isHelperText(raw) && !isPleaseQuestionPrompt(t) && !hasRequiredAsterisk(raw)) continue;
      if (
        looksLikeQuestion(raw) ||
        looksLikeQuestion(t) ||
        isPleaseQuestionPrompt(t) ||
        hasRequiredAsterisk(raw) ||
        /race|gender|veteran|disability|ethnicity|location/i.test(t)
      ) {
        return t;
      }
    }
    return '';
  }

  function labelFor(el) {
    const floatLab = floatingLabelNear(el);
    if (floatLab) return floatLab;

    if (el.labels && el.labels.length) {
      const fromLabels = normalizeLabel(
        Array.from(el.labels)
          .map((l) => {
            const clone = l.cloneNode(true);
            clone.querySelectorAll('input, select, textarea, button, svg').forEach((n) => n.remove());
            return clone.innerText;
          })
          .join(' ')
      );
      // If the associated label bundles question + helper, keep the question-like first sentence
      if (fromLabels && !isHelperText(fromLabels)) return fromLabels;
      if (fromLabels) {
        const parts = fromLabels.split(/(?<=\?)\s+/);
        const qPart = parts.find((p) => looksLikeQuestion(p) && !isHelperText(p));
        if (qPart) return normalizeLabel(qPart);
      }
    }
    const id = el.id;
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab) {
        const clone = lab.cloneNode(true);
        clone.querySelectorAll('input, select, textarea, button, svg').forEach((n) => n.remove());
        const t = normalizeLabel(clone.innerText);
        if (t && !isHelperText(t)) return t;
        if (t) {
          const parts = t.split(/(?<=\?)\s+/);
          const qPart = parts.find((p) => looksLikeQuestion(p) && !isHelperText(p));
          if (qPart) return normalizeLabel(qPart);
        }
      }
    }
    const aria = el.getAttribute('aria-label');
    if (aria && !isHelperText(aria)) return normalizeLabel(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const bits = String(labelledBy)
        .split(/\s+/)
        .map((idRef) => document.getElementById(idRef))
        .filter(Boolean)
        .map((n) => normalizeLabel(n.innerText))
        .filter((t) => t && !isHelperText(t) && !/^(select\.{0,3}|choose)$/i.test(t));
      if (bits.length) return bits.join(' ');
    }

    // Previous sibling / parent heading text (common on custom ATS)
    const scored = [];
    let node = el.parentElement;
    for (let i = 0; i < 5 && node; i++) {
      const candidates = node.querySelectorAll(
        'label, legend, p, h1, h2, h3, h4, span, div, [class*="label"], [class*="InputLabel"], [class*="FormLabel"], [class*="question"], [class*="title"], [class*="description"], [class*="helper"], [class*="hint"]'
      );
      for (const prev of candidates) {
        if (prev === el) continue;
        // Allow labels that wrap the control (MUI outlined select) — use text without nested inputs
        let t = '';
        if (prev.contains(el)) {
          const clone = prev.cloneNode(true);
          clone.querySelectorAll('input, select, textarea, button, svg, [role="button"]').forEach((n) =>
            n.remove()
          );
          t = normalizeLabel(clone.innerText);
        } else {
          if (el.compareDocumentPosition(prev) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
          if (prev.children && prev.children.length > 8) continue;
          t = normalizeLabel(prev.innerText);
        }
        if (!t || t.length < 2 || t.length > 280) continue;
        if (/^(type here|select\.{0,3}|choose)$/i.test(t)) continue;
        if (
          !(
            el.tagName === 'TEXTAREA' ||
            t.length >= 8 ||
            /name|email|phone|race|gender/i.test(t) ||
            isPleaseQuestionPrompt(t)
          )
        ) {
          continue;
        }
        scored.push({ node: prev, text: t });
      }
      node = node.parentElement;
    }
    const picked = pickBestQuestionText(scored, { minLen: 2, maxLen: 280 });
    if (picked) return picked;

    const placeholder = el.getAttribute('placeholder');
    if (placeholder && !/type here|enter text/i.test(placeholder) && !isHelperText(placeholder)) {
      return normalizeLabel(placeholder);
    }
    const name = el.getAttribute('name');
    if (name) return normalizeLabel(name.replace(/[_-]/g, ' '));
    return '';
  }

  function isVisible(el) {
    if (!el || el.disabled) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
      return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Visible text for a single radio/checkbox option (not the group question). */
  function optionLabel(el) {
    if (!el) return '';
    if (el.labels && el.labels.length) {
      const t = normalizeLabel(
        Array.from(el.labels)
          .map((l) => l.innerText)
          .join(' ')
      );
      if (t && t.length < 120) return t;
    }
    const id = el.id;
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab) {
        const t = normalizeLabel(lab.innerText);
        if (t && t.length < 120) return t;
      }
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return normalizeLabel(aria);
    const next = el.nextElementSibling;
    if (next && /^(SPAN|LABEL|DIV|P)$/i.test(next.tagName)) {
      const t = normalizeLabel(next.innerText);
      if (t && t.length < 80) return t;
    }
    const parent = el.closest('label');
    if (parent) {
      const clone = parent.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach((n) => n.remove());
      const t = normalizeLabel(clone.innerText);
      if (t && t.length < 120) return t;
    }
    return normalizeLabel(el.value || '');
  }

  function radiosInGroup(el) {
    if (!el) return [];
    const group = el.name;
    if (group) {
      return Array.from(
        document.querySelectorAll(`input[type="radio"][name="${CSS.escape(group)}"]`)
      );
    }
    const container =
      el.closest('fieldset, [role="radiogroup"], [role="group"]') || el.parentElement;
    return Array.from(container?.querySelectorAll('input[type="radio"]') || [el]);
  }

  /**
   * Infer canonical question from option set — Gender / Race are frequent ATS patterns.
   */
  function inferQuestionFromOptions(optionTexts) {
    const blob = (optionTexts || []).map((t) => String(t || '').toLowerCase()).join(' || ');
    if (!blob) return '';

    const hasMale = /\bmale\b|\bman\b|\bfemale\b|\bwoman\b|\bnon[- ]?binary\b/.test(blob);
    const hasRace =
      /hispanic|latino|asian|african\s+american|\bwhite\b|american\s+indian|alaska\s*nativ|pacific\s+islander|two\s+or\s+more\s+races|not\s+hispanic/.test(
        blob
      );
    const hasDecline = /decline\s+to\s+(self[- ]?identify|state|answer)|prefer\s+not/.test(blob);

    // Race groups often include Hispanic + Asian/White; Gender is Male/Female (± decline)
    if (hasRace && !hasMale) return 'Race';
    if (hasRace && hasMale && /hispanic|asian|african|not\s+hispanic/.test(blob)) {
      // Combined rare; still prefer Race if many race tokens
      const raceHits = (blob.match(/hispanic|asian|african|\bwhite\b|indian|hawaiian|pacific|two\s+or\s+more/g) || [])
        .length;
      if (raceHits >= 2) return 'Race';
    }
    if (hasMale) return 'Gender';

    if (/\bveteran\b/.test(blob) || /protected\s+veteran|disabled\s+veteran/.test(blob)) {
      return 'Veteran status';
    }
    if (/\bdisability\b|disabled\b/.test(blob)) return 'Disability';
    if (/he\s*\/\s*him|she\s*\/\s*her|they\s*\/\s*them/.test(blob)) return 'Pronouns';

    if (hasDecline && /yes/.test(blob) && /no/.test(blob)) return '';
    return '';
  }

  /** Group-level question for radios/checkboxes — never use EEO banners or option labels. */
  function groupQuestionFor(el) {
    if (!el) return '';
    const type = (el.type || '').toLowerCase();
    const radios = type === 'radio' ? radiosInGroup(el) : [];
    const optionTexts = radios.map((r) => optionLabel(r) || r.value || '');

    const inferred = inferQuestionFromOptions(optionTexts);

    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) {
        const t = normalizeLabel(legend.innerText);
        if (
          t &&
          !isEeSectionHeader(t) &&
          !isLikelyOptionLabel(t) &&
          (looksLikeQuestion(t) ||
            /^(gender|race|ethnicity|veteran(\s+status)?|disability(\s+status)?|pronouns?)$/i.test(t))
        ) {
          return t.length > 80 && inferred ? inferred : t;
        }
      }
    }

    const scored = [];
    let node = el.parentElement;
    for (let depth = 0; depth < 6 && node; depth++) {
      const candidates = node.querySelectorAll(
        'legend, label, p, h1, h2, h3, h4, span, div, [class*="label"], [class*="question"], [class*="title"], [class*="heading"]'
      );
      for (const prev of candidates) {
        if (prev === el || prev.contains(el)) continue;
        if (el.compareDocumentPosition(prev) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
        // Skip nodes that are just the option's own label wrapping this radio
        if (radios.some((r) => prev.contains(r) && prev.tagName === 'LABEL')) continue;
        if (
          prev.querySelector?.('input[type="radio"], input[type="checkbox"]') &&
          prev !== fieldset &&
          normalizeLabel(prev.innerText).length > 60
        ) {
          continue;
        }
        const rawPrev = prev.innerText || '';
        let t = hasRequiredAsterisk(rawPrev)
          ? questionTextFromAsteriskLabel(rawPrev)
          : normalizeLabel(rawPrev);
        if (!t || t.length < 2 || t.length > 500) continue;
        if (/^(yes|no|y|n)$/i.test(t)) continue;
        if (isEeSectionHeader(t) || isLikelyOptionLabel(t)) continue;
        // Skip huge blocks that concatenate every option
        if (optionTexts.length >= 2 && optionTexts.filter((o) => o && t.includes(o)).length >= 2) {
          continue;
        }
        scored.push({
          node: prev,
          text: hasRequiredAsterisk(rawPrev) ? `${t} *` : t,
        });
      }
      const role = node.getAttribute?.('role');
      const cls = `${node.className || ''}`;
      if (role === 'group' || role === 'radiogroup' || /question|field-group|form-group|fieldset/i.test(cls)) {
        // keep scanning one more level for a short "Gender" label above the group
      }
      node = node.parentElement;
    }

    // Long required prompts (SRE/DevOps etc.) must not be capped at 120 chars
    const picked = pickBestQuestionText(scored, { minLen: 2, maxLen: 500 });
    if (picked && !isEeSectionHeader(picked) && !isLikelyOptionLabel(picked)) {
      // Prefer canonical Gender/Race/Veteran when DOM label is a long EEO-ish leftover
      if (inferred && (picked.length > 60 || isEeSectionHeader(picked))) return inferred;
      if (
        inferred &&
        /^(gender|race|veteran status|disability)$/i.test(inferred) &&
        !/gender|race|ethnicity|veteran|disability/i.test(picked)
      ) {
        return inferred;
      }
      return picked;
    }

    const named =
      el.getAttribute('aria-labelledby') ||
      el.closest('[aria-labelledby]')?.getAttribute('aria-labelledby');
    if (named) {
      const ref = document.getElementById(String(named).split(/\s+/)[0]);
      if (ref) {
        const t = normalizeLabel(ref.innerText);
        if (t && !isEeSectionHeader(t) && !isLikelyOptionLabel(t) && t.length < 80) return t;
      }
    }

    if (inferred) return inferred;

    const fallback = labelFor(el);
    if (fallback && !isEeSectionHeader(fallback) && !isLikelyOptionLabel(fallback)) return fallback;
    return inferred || '';
  }

  function answersMatch(want, hay) {
    const a = String(want || '')
      .toLowerCase()
      .trim();
    const h = String(hay || '')
      .toLowerCase()
      .trim();
    if (!a || !h) return false;
    if (a === h) return true;
    if (h === a) return true;

    // Decline / prefer-not synonyms (profile "Decline to state" ↔ ATS "Decline to self-identify")
    const declineRe =
      /decline\s+to\s+(self[- ]?identify|state|answer|say)|prefer\s+not\s+to\s+(say|answer|self[- ]?identify)|do\s+not\s+wish|rather\s+not/i;
    if (declineRe.test(a) && declineRe.test(h)) return true;

    if (/^(yes|y|true|1|checked)$/i.test(a) && /^(yes|y|true|1)$/i.test(h)) return true;
    if (/^(no|n|false|0)$/i.test(a) && /^(no|n|false|0)$/i.test(h) && !/not\s+to|know/i.test(h)) {
      return true;
    }
    // Long free-text answers vs short Yes/No option labels
    const aPol = inferAnswerPolarity(a);
    const hPol = inferAnswerPolarity(h);
    if (aPol && hPol && aPol === hPol && (/^(yes|no)$/i.test(h) || /^(yes|no)$/i.test(a))) {
      return true;
    }
    if (/^male$/i.test(a) && /^(male|man|m)$/i.test(h)) return true;
    if (/^female$/i.test(a) && /^(female|woman|f)$/i.test(h)) return true;
    if (/non[- ]?binary/i.test(a) && /non[- ]?binary/i.test(h)) return true;

    // Race: "Asian" ↔ "Asian (Not Hispanic or Latino)"
    const raceKeys = [
      ['american indian', /american\s+indian|alaska\s*nativ/i],
      ['alaskan native', /american\s+indian|alaska\s*nativ/i],
      ['asian', /\basian\b/i],
      ['black', /\bblack\b|african\s+american/i],
      ['african american', /\bblack\b|african\s+american/i],
      ['hispanic', /hispanic|latino|latina|latinx/i],
      ['latino', /hispanic|latino|latina|latinx/i],
      ['white', /\bwhite\b/i],
      ['native hawaiian', /native\s+hawaiian|pacific\s+islander/i],
      ['pacific islander', /native\s+hawaiian|pacific\s+islander/i],
      ['two or more', /two\s+or\s+more\s+races|multiracial/i],
    ];
    for (const [key, re] of raceKeys) {
      if (a.includes(key) && re.test(h)) return true;
    }

    // Token containment — require meaningful length to avoid "a" matching everything
    if (a.length >= 4 && (h.includes(a) || (h.length >= 4 && a.includes(h)))) return true;
    return false;
  }

  /** Best radio option for an answer (exact / race / soft). */
  function findBestRadioMatch(radios, answer, question = '') {
    const a = String(answer || '').trim();
    if (!a || !radios?.length) return null;

    const candidates = expandAnswerCandidates(a, question);
    const scored = radios.map((r) => {
      const lab = optionLabel(r);
      const val = r.value || '';
      let score = 0;
      for (const c of candidates) {
        score = Math.max(score, optionMatchScore(c, lab), optionMatchScore(c, val));
      }
      if (answersMatch(a, val)) score = Math.max(score, 50);
      if (answersMatch(a, lab)) score = Math.max(score, 40);
      const al = a.toLowerCase();
      const ll = lab.toLowerCase();
      if (ll === al || val.toLowerCase() === al) score = Math.max(score, 80);
      if (ll.startsWith(al) && al.length >= 3) score = Math.max(score, 30);
      // Prefer precise race option over a generic decline when answer is a race
      if (/decline|prefer not/i.test(ll) && !/decline|prefer not/i.test(al)) score -= 20;
      if (/hispanic/i.test(ll) && /\basian\b|\bwhite\b|\bblack\b/i.test(al) && !/hispanic/i.test(al)) {
        score -= 30;
      }
      // Prefer longer concrete labels (veteran phrasing) over a bare "No"
      if (lab.length > 12 && /veteran|disability|hispanic/i.test(lab)) score += 3;
      return { r, score, lab };
    });
    scored.sort((x, y) => y.score - x.score);
    return scored[0]?.score > 0 ? scored[0].r : null;
  }

  /** Set checked + fire events React/ATS libs listen for. Avoid double-toggle. */
  function activateToggle(el, checked) {
    if (!el) return false;
    if (!!el.checked === !!checked) {
      // Still notify listeners so frameworks sync
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    try {
      el.focus?.();
    } catch {
      /* ignore */
    }

    // Prefer a real click so custom ATS handlers run (toggles checkbox once)
    try {
      el.click();
    } catch {
      /* ignore */
    }

    if (!!el.checked !== !!checked) {
      const proto = window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'checked');
      if (desc?.set) desc.set.call(el, checked);
      else el.checked = checked;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Radio groups sometimes need the wrapping label when the input is visually hidden
    if (el.type === 'radio' && !!el.checked !== !!checked) {
      const lab = visibleRadioControl(el);
      if (lab) {
        try {
          lab.click();
        } catch {
          /* ignore */
        }
      }
    }
    return !!el.checked === !!checked;
  }

  /** Visible label / button the user would click for a (often hidden) radio input. */
  function visibleRadioControl(radio) {
    if (!radio) return null;
    const lab =
      (radio.labels && radio.labels[0]) ||
      (radio.id ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`) : null) ||
      radio.closest('label');
    if (lab && isVisible(lab)) return lab;

    const parent =
      radio.closest(
        'fieldset, [role="radiogroup"], [role="group"], label, li, [class*="option"], [class*="choice"], [class*="radio"]'
      ) || radio.parentElement;
    if (!parent) return null;

    const want = optionLabel(radio) || radio.value || '';
    const candidates = parent.querySelectorAll(
      'button, [role="radio"], [role="button"], span, div, a'
    );
    for (const c of candidates) {
      if (c === radio || c.contains(radio)) continue;
      if (!isVisible(c)) continue;
      const t = clickableText(c);
      if (!t || t.length > 48) continue;
      if (want && answersMatch(want, t)) return c;
      if (/^(yes|y|no|n)$/i.test(t) && answersMatch(want || radio.value, t)) return c;
    }
    return null;
  }

  function fieldValue(el) {
    const type = (el.type || '').toLowerCase();
    if (type === 'checkbox') {
      return el.checked ? 'Yes' : '';
    }
    if (type === 'radio') {
      if (!el.checked) return '';
      return optionLabel(el) || el.value || 'Yes';
    }
    if (el.tagName === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      if (!opt || opt.value === '' || /select|choose/i.test(opt.text)) return '';
      return (opt.text || opt.value || '').trim();
    }
    return String(el.value || '').trim();
  }

  function clickableText(el) {
    return normalizeLabel(
      el.getAttribute?.('aria-label') ||
        el.getAttribute?.('value') ||
        el.innerText ||
        el.textContent ||
        ''
    );
  }

  function parseRgb(color) {
    const m = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!m) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  }

  function luminance(rgb) {
    if (!rgb) return null;
    return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  }

  /** Ashby/Greenhouse often select via teal fill + light text without aria. */
  function isVisuallySelectedChoice(el, sibling) {
    if (!el || !sibling) return false;
    try {
      const s1 = window.getComputedStyle(el);
      const s2 = window.getComputedStyle(sibling);
      const bg1 = parseRgb(s1.backgroundColor);
      const bg2 = parseRgb(s2.backgroundColor);
      const c1 = parseRgb(s1.color);
      const c2 = parseRgb(s2.color);
      const l1 = luminance(bg1);
      const l2 = luminance(bg2);
      const t1 = luminance(c1);
      const t2 = luminance(c2);
      let score = 0;
      // One darker filled pill vs light empty pill (teal Yes/No)
      if (l1 != null && l2 != null && Math.abs(l1 - l2) >= 0.08) {
        if (l1 < l2) score += 3;
        else score -= 3;
      }
      // Selected text often light on dark fill
      if (t1 != null && t2 != null && Math.abs(t1 - t2) >= 0.18) {
        if (t1 > t2) score += 2;
        else score -= 2;
      }
      // Font-weight bump
      const w1 = Number(s1.fontWeight) || 400;
      const w2 = Number(s2.fontWeight) || 400;
      if (Math.abs(w1 - w2) >= 200) {
        if (w1 > w2) score += 1;
        else score -= 1;
      }
      // Border often stronger when selected
      const b1 = parseRgb(s1.borderTopColor) || parseRgb(s1.outlineColor);
      const b2 = parseRgb(s2.borderTopColor) || parseRgb(s2.outlineColor);
      if (b1 && bg1 && Math.abs(luminance(b1) - l1) < 0.15 && l1 < 0.75) score += 1;
      if (b2 && bg2 && Math.abs(luminance(b2) - l2) < 0.15 && l2 < 0.75) score -= 1;
      return score > 0;
    } catch {
      /* ignore */
    }
    return false;
  }

  function isChoiceControlReady(el) {
    if (!el || !document.contains(el)) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.getAttribute('data-disabled') === 'true') return false;
    try {
      const s = window.getComputedStyle(el);
      if (s.pointerEvents === 'none') return false;
      if (Number(s.opacity) < 0.45) return false;
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    } catch {
      /* ignore */
    }
    const rect = el.getBoundingClientRect?.();
    if (rect && (rect.width < 2 || rect.height < 2)) return false;
    return true;
  }

  /**
   * Whether a Yes/No choice control looks selected.
   * Pass sibling so bare "active" styling isn't treated as selection when both share it.
   */
  function isChoiceSelected(el, sibling) {
    if (!el) return false;
    // Visual comparison first for segmented Yes/No (Ashby etc. often keep aria-pressed=false)
    if (sibling && isVisuallySelectedChoice(el, sibling)) return true;

    const aria = [
      el.getAttribute('aria-pressed'),
      el.getAttribute('aria-checked'),
      el.getAttribute('aria-selected'),
    ];
    if (aria.some((v) => v === 'true')) return true;
    if (el.getAttribute('data-selected') === 'true') return true;
    if (el.getAttribute('data-state') === 'checked' || el.getAttribute('data-state') === 'on') {
      return true;
    }
    if (el.getAttribute('aria-current') === 'true') return true;
    // Nested native input
    const nested = el.querySelector?.('input[type="radio"], input[type="checkbox"]');
    if (nested?.checked) return true;

    const cls = String(el.className || '');
    // Strong selection tokens only (avoid bare "active" / "btn-active" false positives)
    if (
      /\b(selected|is-selected|checked|is-checked|pressed|is-pressed|Mui-selected|Mui-checked)\b/i.test(
        cls
      )
    ) {
      // If sibling also has the token, prefer visual / ignore
      if (sibling) {
        const sCls = String(sibling.className || '');
        if (
          /\b(selected|is-selected|checked|is-checked|pressed|is-pressed|Mui-selected|Mui-checked)\b/i.test(
            sCls
          )
        ) {
          return isVisuallySelectedChoice(el, sibling);
        }
      }
      return true;
    }
    // "active" alone is only trusted when the sibling does not also look active
    if (/\b(active|is-active)\b/i.test(cls)) {
      if (!sibling) return false;
      const sCls = String(sibling.className || '');
      const sibActive = /\b(active|is-active|selected|is-selected|checked)\b/i.test(sCls);
      const sibAria = ['aria-pressed', 'aria-checked', 'aria-selected'].some(
        (a) => sibling.getAttribute?.(a) === 'true'
      );
      if (!sibActive && !sibAria) return true;
      return isVisuallySelectedChoice(el, sibling);
    }
    // Explicit aria false only after visual/class checks failed
    if (aria.some((v) => v === 'false')) return false;
    return false;
  }

  const CHOICE_SELECTOR =
    'button, a, label, [role="button"], [role="radio"], [role="option"], [role="checkbox"], [data-value], [class*="option"], [class*="choice"], [class*="toggle"], [class*="answer"]';

  function looksClickable(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (['BUTTON', 'A', 'LABEL'].includes(tag)) return true;
    if (el.getAttribute('role')) return true;
    if (el.hasAttribute('data-value')) return true;
    if (el.tabIndex >= 0) return true;
    try {
      if (window.getComputedStyle(el).cursor === 'pointer') return true;
    } catch {
      /* ignore */
    }
    const cls = String(el.className || '');
    return /option|choice|answer|select|toggle|btn|button|pill/i.test(cls);
  }

  /** Visible Yes/No even when temporarily disabled (ATS unlocks after prior answers). */
  function isChoiceGeometricallyVisible(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch {
      return false;
    }
  }

  function choiceClickables(root) {
    return Array.from(root.querySelectorAll(CHOICE_SELECTOR)).filter((el) => {
      // Include disabled/locked buttons so we can wait and fill when they unlock
      if (!isChoiceGeometricallyVisible(el) && !isVisible(el)) return false;
      if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return false;
      if (!looksClickable(el)) return false;
      const t = clickableText(el);
      // Prefer short option labels (Yes/No), allow a few common variants
      return t.length > 0 && t.length <= 48;
    });
  }

  function findYesNoPair(clickables) {
    const yes = clickables.find((el) => /^(yes|y)$/i.test(clickableText(el)));
    const no = clickables.find((el) => /^(no|n)$/i.test(clickableText(el)));
    if (!yes || !no || yes === no) return null;
    return { yes, no };
  }

  /** Tree distance between two nodes (lower = closer). */
  function domTreeDistance(a, b) {
    if (!a || !b) return 999;
    if (a === b) return 0;
    const path = (el) => {
      const arr = [];
      while (el) {
        arr.push(el);
        el = el.parentElement;
      }
      return arr;
    };
    const pa = path(a);
    const pb = path(b);
    let i = 0;
    while (
      i < pa.length &&
      i < pb.length &&
      pa[pa.length - 1 - i] === pb[pb.length - 1 - i]
    ) {
      i += 1;
    }
    return pa.length - i + (pb.length - i);
  }

  /**
   * Pair THIS Yes button with its No — never steal the first Yes/No from a
   * parent that contains multiple questions (auth + sponsorship).
   */
  function findYesNoPairFor(yesBtn, clickables) {
    if (!yesBtn) return null;
    const list = clickables || choiceClickables(yesBtn.parentElement || document.body);
    const nos = list.filter(
      (el) => el !== yesBtn && /^(no|n)$/i.test(clickableText(el))
    );
    if (!nos.length) return null;

    // Prefer same immediate parent (segmented control)
    const sameParent = nos.find(
      (n) => n.parentElement && n.parentElement === yesBtn.parentElement
    );
    if (sameParent) return { yes: yesBtn, no: sameParent };

    const allYes = list.filter((el) => /^(yes|y)$/i.test(clickableText(el)));
    let best = null;
    let bestDist = Infinity;
    for (const no of nos) {
      const dist = domTreeDistance(yesBtn, no);
      const stolen = allYes.some((y) => y !== yesBtn && domTreeDistance(y, no) < dist);
      if (stolen) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = no;
      }
    }
    if (!best) return null;
    return { yes: yesBtn, no: best };
  }

  function questionsRoughlyMatch(a, b) {
    const na = normalizeLabel(a)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const nb = normalizeLabel(b)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.includes(nb) || nb.includes(na)) return true;
    // Same EE intent (sponsorship ↔ sponsorship) even when wording drifts
    if (isSponsorshipQuestion(na) && isSponsorshipQuestion(nb)) return true;
    const ia = guessQuestionIntent(na);
    const ib = guessQuestionIntent(nb);
    if (ia && ib && ia === ib) return true;
    const ta = new Set(na.split(' ').filter((t) => t.length > 2));
    const tb = new Set(nb.split(' ').filter((t) => t.length > 2));
    if (ta.size < 3 || tb.size < 3) return false;
    let hits = 0;
    for (const t of ta) if (tb.has(t)) hits += 1;
    return hits / Math.max(ta.size, tb.size) >= 0.55;
  }

  function choiceGroupQuestion(container, yesBtn, noBtn) {
    const stripYesNo = (raw) =>
      normalizeLabel(String(raw || '').replace(/\bYes\b/gi, ' ').replace(/\bNo\b/gi, ' '));

    const scored = [];
    const pushCand = (node, rawText) => {
      const raw = String(rawText || '');
      // Skip helper lines that sit between the ?* prompt and Yes/No
      if (isAtsHelperNote(raw)) return;
      const required = hasRequiredAsterisk(raw);
      const t = stripYesNo(raw);
      if (isAtsHelperNote(t) || (isHelperText(raw) && !required && !/\?/.test(t))) return;
      const min = required || /\?/.test(t) ? 2 : 8;
      if (!t || t.length < min || t.length > 500) return;
      // Keep original raw so questionScore sees the asterisk
      scored.push({ node, text: required ? `${t} *` : t });
    };

    let sib = container.previousElementSibling;
    for (let i = 0; i < 10 && sib; i++) {
      // Walk past helper siblings to the real ?* question above
      pushCand(sib, sib.innerText);
      sib = sib.previousElementSibling;
    }

    let parent = container.parentElement;
    for (let depth = 0; depth < 6 && parent; depth++) {
      const candidates = parent.querySelectorAll(
        'label, legend, p, h1, h2, h3, h4, span, div, [class*="label"], [class*="question"], [class*="title"], [class*="heading"], [class*="description"], [class*="helper"], [class*="hint"]'
      );
      for (const node of candidates) {
        if (node === container || node.contains(yesBtn) || node.contains(noBtn)) continue;
        if (container.contains(node) && node.querySelector('button, [role="button"]')) continue;
        if (yesBtn.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
        // Skip huge wrappers that concatenate question + helper + controls
        if (node !== parent && node.querySelector && node.querySelectorAll('p, label, button').length > 4) {
          continue;
        }
        pushCand(node, node.innerText);
      }
      parent = parent.parentElement;
    }

    // aria-labelledby on the control group
    const labelled =
      container.getAttribute?.('aria-labelledby') ||
      container.parentElement?.getAttribute?.('aria-labelledby');
    if (labelled) {
      String(labelled)
        .split(/\s+/)
        .forEach((id) => {
          const ref = document.getElementById(id);
          if (ref) pushCand(ref, ref.innerText);
        });
    }

    return pickBestQuestionText(scored, { minLen: 3, maxLen: 500 });
  }

  /** Custom ATS Yes/No (and similar) button groups that are not native radios. */
  function collectChoiceButtonGroups(seenQuestionKeys) {
    const groups = [];
    const seen = new Set();
    const usedButtons = new Set();
    const yesCandidates = Array.from(document.querySelectorAll(CHOICE_SELECTOR)).filter((el) => {
      if (!isChoiceGeometricallyVisible(el) && !isVisible(el)) return false;
      if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return false;
      if (!looksClickable(el)) return false;
      return /^(yes|y)$/i.test(clickableText(el));
    });

    for (const yesBtn of yesCandidates) {
      if (usedButtons.has(yesBtn)) continue;

      let container = yesBtn.parentElement;
      for (let depth = 0; depth < 6 && container; depth++) {
        if (container.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) break;

        const clickables = choiceClickables(container);
        // Always bind to THIS yesBtn — parent sections often contain auth + sponsorship
        const pair = findYesNoPairFor(yesBtn, clickables);
        if (!pair) {
          container = container.parentElement;
          continue;
        }

        const yesCount = clickables.filter((el) =>
          /^(yes|y)$/i.test(clickableText(el))
        ).length;
        // Multiple Yes/No questions in this container: only accept sibling pairs
        if (yesCount > 1 && pair.yes.parentElement !== pair.no.parentElement) {
          container = container.parentElement;
          continue;
        }

        // Avoid huge page sections that happen to contain Yes/No somewhere
        if (clickables.length > 8 && yesCount > 1) {
          container = container.parentElement;
          continue;
        }

        // Prefer custom UI: skip when a visible native radio group already covers this
        const nativeRadios = Array.from(container.querySelectorAll('input[type="radio"]')).filter(
          isVisible
        );
        if (nativeRadios.length >= 2) {
          break;
        }

        // Question text from the tight control first, then wider container
        const tight = pair.yes.parentElement || container;
        const question =
          choiceGroupQuestion(tight, pair.yes, pair.no) ||
          choiceGroupQuestion(container, pair.yes, pair.no);
        // Accept short required titles ("Location *") and long essay Yes/No prompts
        if (!question || question.length < 3) {
          container = container.parentElement;
          continue;
        }

        const qKey = question.toLowerCase();
        if (seen.has(qKey) || seenQuestionKeys.has(qKey)) break;
        seen.add(qKey);
        usedButtons.add(pair.yes);
        usedButtons.add(pair.no);

        const slug = qKey.replace(/[^a-z0-9]+/g, '_').slice(0, 48);
        groups.push({
          // Stable across re-scans so GENERATE_ANSWERS ids still match fillAnswers
          id: `choice_${slug || groups.length}`,
          question,
          tag: 'choice',
          type: 'choice-button',
          placeholder: '',
          element: tight,
          options: { yes: pair.yes, no: pair.no },
        });
        break;
      }
    }

    return groups;
  }

  /** Guess EE intent from question text (client-side, mirrors backend detectors). */
  function guessQuestionIntent(question) {
    const q = normalizeLabel(question).toLowerCase();
    if (!q) return null;
    if (
      /\b(sponsor|sponsorship|h-?1b|f-?1\b|opt\b|require\s+(an?\s+)?visa|require\s+sponsorship|employer\s+sponsor)\b/i.test(
        q
      )
    ) {
      return 'sponsorship';
    }
    if (
      /\b(authorized\s+to\s+work|work\s+authorization|legally\s+authorized|eligible\s+to\s+work|right\s+to\s+work)\b/i.test(
        q
      )
    ) {
      return 'work_auth';
    }
    if (/\bveteran\b/i.test(q)) return 'veteran';
    if (/\bdisability\b/i.test(q)) return 'disability';
    if (/\bgender\b/i.test(q)) return 'gender';
    if (/\b(race|ethnicity)\b/i.test(q)) return 'race';
    if (/\blgbtq\b/i.test(q)) return 'lgbtq';
    if (/\b(hispanic|latino)\b/i.test(q)) return 'hispanic';
    if (
      /\b((live|living|reside|residing|based)\b.{0,48}\bunited\s+states|\bunited\s+states\b.{0,48}\b(live|living|reside|residing|based))\b/i.test(
        q
      )
    ) {
      return 'us_residence';
    }
    return null;
  }

  /** Match API answer row to a live field even when ids / exact labels drift. */
  function findAnswerRecord(q, answers, byId, byQuestion) {
    if (!q || !answers?.length) return null;
    let rec = byId.get(q.id);
    if (rec?.answer) return rec;
    const qn = normalizeLabel(q.question).toLowerCase();
    rec = byQuestion.get(qn);
    if (rec?.answer) return rec;

    for (const a of answers) {
      if (!a?.answer) continue;
      if (questionsRoughlyMatch(a.question, q.question)) return a;
    }

    const intent = q.intent || guessQuestionIntent(q.question);
    if (intent) {
      const byIntent = answers.find(
        (a) => a.answer && (a.intent === intent || guessQuestionIntent(a.question) === intent)
      );
      if (byIntent) return byIntent;
    }
    return rec || byId.get(q.id) || null;
  }

  /**
   * Custom ATS radio groups ([role=radio]) that are not native <input type="radio">
   * and not short Yes/No choice buttons — e.g. Veteran Status OFCCP options.
   */
  function collectAriaRadioGroups(seenQuestionKeys) {
    const groups = [];
    const used = new Set();

    const ariaRadios = Array.from(document.querySelectorAll('[role="radio"]')).filter((el) => {
      if (used.has(el)) return false;
      if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return false;
      if (!isChoiceGeometricallyVisible(el) && !isVisible(el)) return false;
      // Skip Yes/No segmented controls — handled as choice-button
      const t = clickableText(el);
      if (/^(yes|y|no|n)$/i.test(t)) return false;
      // Prefer longer option labels (EE / veteran / disability)
      return t.length >= 8;
    });

    for (const seed of ariaRadios) {
      if (used.has(seed)) continue;
      const root =
        seed.closest('[role="radiogroup"], fieldset, [role="group"]') ||
        seed.parentElement?.parentElement ||
        seed.parentElement;
      if (!root || used.has(root)) continue;

      const peers = Array.from(root.querySelectorAll('[role="radio"]')).filter((el) => {
        if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return false;
        const t = clickableText(el);
        return t.length >= 8 && !/^(yes|y|no|n)$/i.test(t);
      });
      if (peers.length < 2) continue;

      // Skip if this radiogroup already has native inputs collected
      const native = root.querySelectorAll('input[type="radio"]');
      if (native.length >= 2) {
        peers.forEach((p) => used.add(p));
        continue;
      }

      const optionLabels = peers.map((el) => clickableText(el) || normalizeLabel(el.innerText));
      let question =
        groupQuestionForAria(root, peers, optionLabels) ||
        inferQuestionFromOptions(optionLabels);
      if (!question || question.length < 2) continue;
      if (isEeSectionHeader(question) || isLikelyOptionLabel(question)) {
        question = inferQuestionFromOptions(optionLabels);
      }
      if (!question) continue;

      const qk = normalizeLabel(question)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (!qk || seenQuestionKeys.has(qk)) {
        peers.forEach((p) => used.add(p));
        continue;
      }
      seenQuestionKeys.add(qk);
      peers.forEach((p) => used.add(p));
      used.add(root);

      const slug = qk.replace(/[^a-z0-9]+/g, '_').slice(0, 48);
      groups.push({
        id: `aria_radio_${slug || groups.length}`,
        question,
        tag: 'aria-radio',
        type: 'radio',
        placeholder: '',
        element: peers[0],
        options: optionLabels,
        ariaRadios: peers,
      });
    }

    return groups;
  }

  function groupQuestionForAria(root, peers, optionLabels) {
    const scored = [];
    const skipContainsRadio = (node) =>
      peers.some((r) => node === r || node.contains?.(r)) &&
      normalizeLabel(node.innerText).length > 40;

    let sib = root.previousElementSibling;
    for (let i = 0; i < 5 && sib; i++) {
      const t = normalizeLabel(sib.innerText);
      if (t && t.length >= 2 && t.length <= 120 && !isEeSectionHeader(t) && !isLikelyOptionLabel(t)) {
        scored.push({ node: sib, text: t });
      }
      sib = sib.previousElementSibling;
    }

    let node = root;
    for (let depth = 0; depth < 5 && node; depth++) {
      const candidates = node.querySelectorAll(
        'legend, label, p, h1, h2, h3, h4, span, div, [class*="label"], [class*="question"], [class*="title"]'
      );
      for (const prev of candidates) {
        if (skipContainsRadio(prev)) continue;
        if (peers.some((r) => prev.contains(r) && prev.tagName === 'LABEL')) continue;
        const t = normalizeLabel(prev.innerText);
        if (!t || t.length < 2 || t.length > 120) continue;
        if (isEeSectionHeader(t) || isLikelyOptionLabel(t)) continue;
        if (optionLabels.filter((o) => o && t.includes(o)).length >= 2) continue;
        scored.push({ node: prev, text: t });
      }
      node = node.parentElement;
    }

    const picked = pickBestQuestionText(scored, { minLen: 2, maxLen: 120 });
    const inferred = inferQuestionFromOptions(optionLabels);
    if (picked && inferred && picked.length > 60) return inferred;
    if (
      picked &&
      inferred &&
      /^(gender|race|veteran status|disability)$/i.test(inferred) &&
      !/gender|race|ethnicity|veteran|disability/i.test(picked)
    ) {
      return inferred;
    }
    return picked || inferred || '';
  }

  /** Re-resolve Yes/No for a question so we never click a neighboring group's buttons. */
  function resolveChoicePair(q) {
    const y = q?.options?.yes;
    const n = q?.options?.no;
    if (y && n && document.contains(y) && document.contains(n)) {
      if (y.parentElement && y.parentElement === n.parentElement) {
        const near = choiceGroupQuestion(y.parentElement, y, n);
        if (!near || questionsRoughlyMatch(near, q.question)) {
          return { yes: y, no: n };
        }
      }
    }

    const yesCandidates = Array.from(document.querySelectorAll(CHOICE_SELECTOR)).filter((el) => {
      if (!isChoiceGeometricallyVisible(el) && !isVisible(el)) return false;
      if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return false;
      if (!looksClickable(el)) return false;
      return /^(yes|y)$/i.test(clickableText(el));
    });

    let best = null;
    let bestScore = -1;
    for (const yesBtn of yesCandidates) {
      const pair = findYesNoPairFor(yesBtn, choiceClickables(yesBtn.parentElement || document.body));
      if (!pair) continue;
      const root = pair.yes.parentElement || q.element;
      const near = choiceGroupQuestion(root, pair.yes, pair.no);
      if (!near) continue;
      if (!questionsRoughlyMatch(near, q.question)) continue;
      const na = normalizeLabel(near).toLowerCase();
      const nb = normalizeLabel(q.question).toLowerCase();
      const score = na === nb ? 100 : na.includes(nb) || nb.includes(na) ? 80 : 50;
      if (score > bestScore) {
        bestScore = score;
        best = pair;
      }
    }
    if (best) return best;
    if (y && n && document.contains(y) && document.contains(n)) return { yes: y, no: n };
    return null;
  }

  function choiceGroupValue(q) {
    if (!q?.options) return '';
    const yesSel = isChoiceSelected(q.options.yes, q.options.no);
    const noSel = isChoiceSelected(q.options.no, q.options.yes);
    if (yesSel && !noSel) return 'Yes';
    if (noSel && !yesSel) return 'No';
    return '';
  }

  /** Single interaction — never click + synthetic click (that toggles Yes/No off). */
  function clickOnce(el) {
    if (!el || !document.contains(el)) return false;
    try {
      el.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    } catch {
      /* ignore */
    }
    try {
      el.focus?.();
    } catch {
      /* ignore */
    }
    // Prefer a full pointer sequence once — Ashby/React often ignore bare .click()
    try {
      const opts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        buttons: 1,
      };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
      return true;
    } catch {
      try {
        el.click();
        return true;
      } catch {
        return false;
      }
    }
  }

  function altChoiceClickTargets(el) {
    if (!el) return [];
    const out = [];
    const want = clickableText(el);
    const push = (n) => {
      if (n && document.contains(n) && !out.includes(n)) out.push(n);
    };
    push(el);
    // Inner text node wrappers / icons parents often receive the handler
    const innerBtn = el.querySelector?.(
      'button, [role="button"], [role="radio"], input[type="radio"], input[type="checkbox"]'
    );
    push(innerBtn);
    if (el.tagName === 'LABEL' && el.control) push(el.control);
    const forId = el.getAttribute?.('for');
    if (forId) push(document.getElementById(forId));
    // Parent clickable only when its label is the same Yes/No text (not the whole group)
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++) {
      const pt = clickableText(p);
      if (looksClickable(p) && pt && pt.length <= 48 && answersMatch(want, pt)) push(p);
      p = p.parentElement;
    }
    return out;
  }

  function settleUi(ms = 40) {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        setTimeout(resolve, ms);
      });
    });
  }

  async function waitForChoiceReady(pair, timeoutMs = 2200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (
        pair?.yes &&
        pair?.no &&
        document.contains(pair.yes) &&
        document.contains(pair.no) &&
        isChoiceControlReady(pair.yes) &&
        isChoiceControlReady(pair.no)
      ) {
        return true;
      }
      await settleUi(120);
    }
    return !!(
      pair?.yes &&
      pair?.no &&
      isChoiceControlReady(pair.yes) &&
      isChoiceControlReady(pair.no)
    );
  }

  function isSponsorshipQuestion(text) {
    const q = normalizeLabel(text).toLowerCase();
    if (!q) return false;
    return /\b(sponsor|sponsorship|h-?1b|f-?1\b|opt\b|require\s+(an?\s+)?visa|require\s+sponsorship|employer\s+sponsor|employment\s+visa(\s+status)?|immigration\s+sponsorship)\b/i.test(
      q
    );
  }

  /** Real user-like click — Ashby/React often ignore a single synthetic event. */
  async function hardClickElement(el) {
    if (!el || !document.contains(el)) return false;
    try {
      el.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
    } catch {
      try {
        el.scrollIntoView?.({ block: 'center' });
      } catch {
        /* ignore */
      }
    }
    await settleUi(40);

    const rect = el.getBoundingClientRect?.();
    const cx = rect ? rect.left + rect.width / 2 : 0;
    const cy = rect ? rect.top + rect.height / 2 : 0;
    const targets = [];
    const push = (n) => {
      if (n && document.contains(n) && !targets.includes(n)) targets.push(n);
    };
    if (rect && rect.width > 0 && rect.height > 0) {
      try {
        push(document.elementFromPoint(cx, cy));
      } catch {
        /* ignore */
      }
    }
    for (const n of altChoiceClickTargets(el)) push(n);
    push(el);

    const firePointer = (node) => {
      const r = node.getBoundingClientRect?.() || rect;
      const x = r ? r.left + r.width / 2 : cx;
      const y = r ? r.top + r.height / 2 : cy;
      const base = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: 0,
        buttons: 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      };
      try {
        node.dispatchEvent(new PointerEvent('pointerover', base));
        node.dispatchEvent(new PointerEvent('pointerenter', { ...base, bubbles: false }));
        node.dispatchEvent(new MouseEvent('mouseover', base));
        node.dispatchEvent(new PointerEvent('pointerdown', base));
        node.dispatchEvent(new MouseEvent('mousedown', base));
        node.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
        node.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
        node.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
      } catch {
        /* ignore */
      }
      try {
        HTMLElement.prototype.click.call(node);
      } catch {
        try {
          node.click?.();
        } catch {
          /* ignore */
        }
      }
    };

    for (const node of targets) {
      try {
        node.focus?.({ preventScroll: true });
      } catch {
        try {
          node.focus?.();
        } catch {
          /* ignore */
        }
      }
      firePointer(node);
      await settleUi(50);
      try {
        node.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
        );
        node.dispatchEvent(
          new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
        );
      } catch {
        /* ignore */
      }
      await settleUi(40);
    }
    return true;
  }

  /** Locate every Yes/No pair whose nearby label is a sponsorship question. */
  function findSponsorshipChoicePairs() {
    const out = [];
    const seen = new Set();
    const yesCandidates = Array.from(document.querySelectorAll(CHOICE_SELECTOR)).filter((el) => {
      if (!isChoiceGeometricallyVisible(el) && !isVisible(el)) return false;
      if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return false;
      if (!looksClickable(el)) return false;
      return /^(yes|y)$/i.test(clickableText(el));
    });

    for (const yesBtn of yesCandidates) {
      const pair = findYesNoPairFor(yesBtn, choiceClickables(yesBtn.parentElement || document.body));
      if (!pair?.no) continue;
      if (seen.has(pair.no)) continue;
      const root = pair.yes.parentElement || pair.no.parentElement;
      const near =
        choiceGroupQuestion(root, pair.yes, pair.no) ||
        choiceGroupQuestion(root?.parentElement || root, pair.yes, pair.no);
      if (!isSponsorshipQuestion(near)) continue;
      seen.add(pair.no);
      out.push({ ...pair, question: near, element: root });
    }
    return out;
  }

  function sponsorshipPairSelectedNo(pair) {
    if (!pair?.yes || !pair?.no) return false;
    const live = { options: { yes: pair.yes, no: pair.no } };
    if (choiceGroupValue(live) === 'No') return true;
    // Fallback: No looks selected / Yes does not
    if (isChoiceSelected(pair.no, pair.yes) && !isChoiceSelected(pair.yes, pair.no)) return true;
    if (pair.no.getAttribute('aria-pressed') === 'true') return true;
    if (pair.no.getAttribute('aria-checked') === 'true') return true;
    return false;
  }

  /**
   * Hard guarantee: sponsorship → click No.
   * Ignores missing API answers and keeps retrying past flaky ready/visual checks.
   */
  async function forceSponsorshipNo(q = null) {
    let pair = q ? resolveChoicePair(q) : null;
    if ((!pair?.no || !isSponsorshipQuestion(q?.question)) && q?.question) {
      // Re-find by sponsorship label on the page
      const hits = findSponsorshipChoicePairs();
      const match =
        hits.find((h) => questionsRoughlyMatch(h.question, q.question)) ||
        hits.find((h) => isSponsorshipQuestion(h.question)) ||
        null;
      if (match) pair = match;
    }
    if (!pair?.no) {
      const hits = findSponsorshipChoicePairs();
      pair = hits[0] || null;
    }
    if (!pair?.no || !document.contains(pair.no)) return false;

    if (q) q.options = { yes: pair.yes, no: pair.no };

    if (sponsorshipPairSelectedNo(pair)) {
      pair.no.classList?.add('hs-filled');
      return true;
    }

    // Wait briefly for unlock, but click anyway even if still "locked"
    await waitForChoiceReady(pair, 1800);
    pair = (q && resolveChoicePair(q)) || pair;

    for (let attempt = 0; attempt < 5; attempt++) {
      if (!pair?.no || !document.contains(pair.no)) break;
      // If Yes is wrongly selected, click No harder
      await hardClickElement(pair.no);
      await settleUi(120 + attempt * 80);
      if (sponsorshipPairSelectedNo(pair)) {
        pair.no.classList?.add('hs-filled');
        if (q) q.options = { yes: pair.yes, no: pair.no };
        return true;
      }
      // Re-resolve in case ATS re-rendered the buttons
      const refreshed = q ? resolveChoicePair(q) : null;
      if (refreshed?.no) pair = refreshed;
      else {
        const hits = findSponsorshipChoicePairs();
        const again =
          (q && hits.find((h) => questionsRoughlyMatch(h.question, q.question))) || hits[0];
        if (again) pair = again;
      }
    }

    const ok = sponsorshipPairSelectedNo(pair);
    if (ok) {
      pair.no.classList?.add('hs-filled');
      if (q) q.options = { yes: pair.yes, no: pair.no };
    }
    return ok;
  }

  /** Page-wide sweep: every sponsorship Yes/No → No. */
  async function forceAllSponsorshipNos() {
    const pairs = findSponsorshipChoicePairs();
    let n = 0;
    for (const pair of pairs) {
      if (sponsorshipPairSelectedNo(pair)) {
        n += 1;
        continue;
      }
      const ok = await forceSponsorshipNo({
        question: pair.question,
        options: { yes: pair.yes, no: pair.no },
        element: pair.element,
        type: 'choice-button',
      });
      if (ok) n += 1;
    }
    return n;
  }

  async function fillChoiceButtons(q, answer) {
    // Sponsorship is always No — dedicated hard path
    if (isSponsorshipQuestion(q?.question) || guessQuestionIntent(q?.question) === 'sponsorship') {
      return forceSponsorshipNo(q);
    }

    const a = String(answer || '')
      .toLowerCase()
      .trim();
    let wantYes = null;
    if (/^(yes|y|true|1)$/i.test(a)) wantYes = true;
    else if (/^(no|n|false|0)$/i.test(a)) wantYes = false;
    else if (/yes/i.test(a) && !/no/i.test(a)) wantYes = true;
    else if (/^no\b|not\b|n't\b/i.test(a)) wantYes = false;
    if (wantYes == null) return false;

    // Re-bind to the pair whose nearby label matches THIS question (not the neighbor)
    let pair = resolveChoicePair(q);
    if (!pair?.yes || !pair?.no) return false;

    // Wait until ATS enables the Yes/No controls (often locked until prior fields fill)
    const ready = await waitForChoiceReady(pair, 2400);
    pair = resolveChoicePair(q) || pair;
    if (!pair?.yes || !pair?.no) return false;

    const liveQ = { ...q, options: pair };
    const target = wantYes ? pair.yes : pair.no;
    if (!target || !document.contains(target)) return false;

    const desired = wantYes ? 'Yes' : 'No';
    if (choiceGroupValue(liveQ) === desired) {
      target.classList.add('hs-filled');
      q.options = pair;
      return true;
    }

    // Click even when ATS still reports locked — many unlock on interaction
    for (const node of altChoiceClickTargets(target)) {
      await hardClickElement(node);
      await settleUi(90);
      if (choiceGroupValue(liveQ) === desired) {
        target.classList.add('hs-filled');
        q.options = pair;
        return true;
      }
      if (choiceGroupValue(liveQ) && choiceGroupValue(liveQ) !== desired) break;
    }

    await settleUi(280);
    pair = resolveChoicePair(q) || pair;
    const liveQ2 = { ...q, options: pair };
    const target2 = wantYes ? pair.yes : pair.no;
    if (target2 && choiceGroupValue(liveQ2) !== desired) {
      await hardClickElement(target2);
      await settleUi(120);
    }

    const ok = choiceGroupValue(liveQ2) === desired;
    if (ok) {
      target2?.classList?.add('hs-filled');
      q.options = pair;
    } else if (!ready) {
      // Last chance after unlock delay
      await settleUi(400);
      if (target2) await hardClickElement(target2);
      await settleUi(120);
      if (choiceGroupValue({ ...q, options: pair }) === desired) {
        target2?.classList?.add('hs-filled');
        q.options = pair;
        return true;
      }
    }
    return ok;
  }

  function isFieldCollectible(el) {
    if (!el) return false;
    if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return false;
    if (isVisible(el)) return true;
    const type = (el.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return true;
    // MUI outlined selects: native <select>/input is hidden; floating label wrapper is visible
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT') {
      const wrap = el.closest(
        '.MuiFormControl-root, .MuiTextField-root, [class*="FormControl"], [class*="form-control"], [class*="field"], [class*="select"]'
      );
      if (wrap && isVisible(wrap)) {
        if (floatingLabelNear(el)) return true;
        const visibleControl = wrap.querySelector(
          '[role="combobox"], [role="button"], [class*="Select"], [class*="select"]'
        );
        if (visibleControl && isVisible(visibleControl)) return true;
      }
    }
    return false;
  }

  /**
   * Options as plain strings for the backend / LLM. Choice-button groups carry DOM elements
   * ({ yes, no }) that don't survive messaging, so they become ['Yes', 'No'].
   */
  function serializableOptions(options) {
    if (Array.isArray(options)) {
      const list = options.map((o) => normalizeLabel(String(o ?? ''))).filter(Boolean);
      return list.length ? list.slice(0, 60) : undefined;
    }
    if (options && options.yes && options.no) return ['Yes', 'No'];
    return undefined;
  }
  HS.serializableOptions = serializableOptions;

  function selectOptionLabels(select) {
    return Array.from(select.options || [])
      .filter((o) => !o.disabled && String(o.value ?? '') !== '')
      .map((o) => normalizeLabel(o.textContent || o.label || ''))
      .filter((t) => t && !/^(select|choose|please select|--)/i.test(t));
  }

  HS.collectQuestions = function collectQuestions() {
    const questions = [];
    const seen = new Set();
    const seenQuestionKeys = new Set();
    const radioGroups = new Set();

    const fields = document.querySelectorAll('input, textarea, select');
    fields.forEach((el, index) => {
      if (!isFieldCollectible(el)) return;
      // Work/education entries are filled from the resume (HS.fillHistory), not as Q&A
      if (isHistoryField(el)) return;

      const type = (el.type || el.tagName).toLowerCase();
      if (SKIP_TYPES.has(type)) return;

      if (el.tagName === 'INPUT') {
        const ok = [
          'text',
          'email',
          'tel',
          'url',
          'number',
          'search',
          'checkbox',
          'radio',
          'date',
          'datetime-local',
          'month',
          'week',
          '',
        ].includes(type);
        if (!ok) return;
      }

      let optionLabels = [];
      if (type === 'radio') {
        const group = el.name || el.id || `radio_${index}`;
        if (radioGroups.has(group)) return;
        radioGroups.add(group);
        optionLabels = radiosInGroup(el)
          .map((r) => optionLabel(r) || r.value || '')
          .filter(Boolean);
      } else if (el.tagName === 'SELECT') {
        // Lets the backend / LLM answer with a value that actually exists in the dropdown
        optionLabels = selectOptionLabels(el);
      }

      let question =
        type === 'radio' || type === 'checkbox'
          ? groupQuestionFor(el)
          : floatingLabelNear(el) || labelFor(el);

      // Never keep EEO banners / option text as the question
      if (question && (isEeSectionHeader(question) || isLikelyOptionLabel(question))) {
        question = '';
      }
      if (!question && type === 'radio') {
        question = inferQuestionFromOptions(optionLabels);
      }
      // Last chance for race/gender floating labels
      if (!question) question = floatingLabelNear(el);

      // Weak labels: walk previous siblings (skip hire-visa helper notes)
      if (
        !question ||
        question.length < 8 ||
        !looksLikeQuestion(question) ||
        isAtsHelperNote(question)
      ) {
        let sib = el.previousElementSibling;
        for (let i = 0; i < 8 && sib; i++) {
          const raw = sib.innerText || '';
          if (isAtsHelperNote(raw) || isBareAsteriskNode(sib)) {
            // Keep walking past helper / bare * to the real prompt
            sib = sib.previousElementSibling;
            continue;
          }
          const fromStar = resolveAsteriskQuestionFromNode(sib);
          const t = fromStar || normalizeLabel(raw);
          if (
            t &&
            t.length >= 2 &&
            t.length < 500 &&
            !isEeSectionHeader(t) &&
            !isAtsHelperNote(t) &&
            (fromStar ||
              hasRequiredAsterisk(raw) ||
              looksLikeQuestion(raw) ||
              looksLikeQuestion(t))
          ) {
            question = t;
            break;
          }
          sib = sib.previousElementSibling;
        }
      }
      if (question && isAtsHelperNote(question)) question = '';
      if (!question || question.length < 2) return;

      const qk = normalizeLabel(question)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      const key = `${el.name || el.id || index}::${qk}`;
      // One progress/fill row per question text — avoid duplicate Location / age rows
      if (seen.has(key) || seenQuestionKeys.has(qk)) return;
      seen.add(key);
      seenQuestionKeys.add(qk);

      const rawType = (el.type || '').toLowerCase();
      const fieldType =
        type === 'radio' || type === 'checkbox'
          ? rawType
          : isComboboxLike(el)
            ? 'combobox'
            : rawType || el.tagName.toLowerCase();

      questions.push({
        id: el.name || el.id || `field_${index}`,
        question,
        tag: el.tagName.toLowerCase(),
        type: fieldType,
        placeholder: el.getAttribute('placeholder') || '',
        element: el,
        options: optionLabels.length ? optionLabels : undefined,
      });
    });

    collectChoiceButtonGroups(seenQuestionKeys).forEach((g) => {
      const qk = normalizeLabel(g.question)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (!qk || seenQuestionKeys.has(qk)) return;
      seenQuestionKeys.add(qk);
      questions.push(g);
    });

    collectAriaRadioGroups(seenQuestionKeys).forEach((g) => {
      questions.push(g);
    });

    // Catch required (*) prompts the input walk / Yes-No scan missed
    collectAsteriskLabeledFields(seenQuestionKeys).forEach((g) => {
      questions.push(g);
    });

    return questions.filter((q) => {
      if (!q.element) return true;
      if (isHistoryField(q.element)) return false;
      // "*"-label rows point at the label; check the control it introduces
      if (q.type === 'unbound') {
        const control = findTextControlAfterLabel(q.element) || findControlAfterLabel(q.element);
        if (control && isHistoryField(control)) return false;
      }
      return true;
    });
  };

  /** True when node is only a required star (or star + whitespace). */
  function isBareAsteriskNode(node) {
    const t = String(node?.innerText || node?.textContent || '')
      .replace(/\u00a0/g, ' ')
      .trim();
    return /^\*+$/.test(t);
  }

  /**
   * Join "question text" + adjacent red "*" span into one prompt.
   * Many ATS split the asterisk into its own element.
   */
  function resolveAsteriskQuestionFromNode(node) {
    if (!node) return '';
    const raw = node.innerText || node.textContent || '';
    if (isAtsHelperNote(raw)) return '';
    if (isBareAsteriskNode(node)) {
      // Prefer previous sibling question text + this star
      const prev = node.previousElementSibling;
      if (prev) {
        const prevRaw = prev.innerText || prev.textContent || '';
        if (prevRaw && !isAtsHelperNote(prevRaw) && !isBareAsteriskNode(prev)) {
          return questionTextFromAsteriskLabel(`${prevRaw} *`);
        }
      }
      const parentRaw = node.parentElement?.innerText || '';
      if (hasRequiredAsterisk(parentRaw)) {
        return questionTextFromAsteriskLabel(parentRaw);
      }
      return '';
    }
    if (hasRequiredAsterisk(raw)) {
      return questionTextFromAsteriskLabel(raw);
    }
    // Question without *; next sibling is bare *
    const next = node.nextElementSibling;
    if (next && isBareAsteriskNode(next)) {
      const q = normalizeLabel(raw);
      if (q && !isAtsHelperNote(q)) return q;
    }
    // Parent packs question + * (+ maybe helper)
    const parent = node.parentElement;
    if (parent) {
      const parentRaw = parent.innerText || parent.textContent || '';
      if (hasRequiredAsterisk(parentRaw)) {
        const nested = parent.querySelectorAll(
          'input:not([type="hidden"]), textarea, select, button'
        ).length;
        // Only lift from a tight label wrapper, not the whole form
        if (nested <= 2) {
          const q = questionTextFromAsteriskLabel(parentRaw);
          if (q && q.length >= 2) return q;
        }
      }
    }
    return '';
  }

  /** Control is after the label in document order (not a previous question's radios). */
  function controlFollowsLabel(labelNode, el) {
    if (!labelNode || !el) return false;
    const pos = labelNode.compareDocumentPosition(el);
    return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  /** Stop at the next *-question so we don't steal the following field's controls. */
  function isNextAsteriskQuestionBoundary(node) {
    if (!node || node.nodeType !== 1) return false;
    const raw = node.innerText || node.textContent || '';
    if (!hasRequiredAsterisk(raw) && !resolveAsteriskQuestionFromNode(node)) return false;
    const q = resolveAsteriskQuestionFromNode(node) || questionTextFromAsteriskLabel(raw);
    // Allow short required titles like "Location *"
    if (!q || q.length < 2) return false;
    if (isAtsHelperNote(q)) return false;
    return looksLikeQuestion(q) || hasRequiredAsterisk(raw);
  }

  /** Every element that looks like a required (*) application prompt. */
  function harvestAsteriskLabelNodes() {
    const selector =
      'label, legend, p, h1, h2, h3, h4, h5, h6, span, div, li, dt, strong, b, [class*="label"], [class*="Label"], [class*="question"], [class*="Question"], [class*="title"], [class*="Title"], [class*="heading"], [class*="Heading"], [class*="FieldLabel"], [class*="field-label"], [class*="form-label"], [data-testid*="label"], [data-testid*="question"]';
    const set = new Set();
    for (const node of document.querySelectorAll(selector)) {
      if (node.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) continue;
      const raw = node.innerText || node.textContent || '';
      if (!raw.includes('*') && !Array.from(node.children || []).some(isBareAsteriskNode)) {
        continue;
      }
      if (resolveAsteriskQuestionFromNode(node) || hasRequiredAsterisk(raw)) {
        set.add(node);
      }
    }
    // Also catch bare "*" spans and attach via resolveAsteriskQuestionFromNode
    for (const node of document.querySelectorAll('span, sup, abbr, i, em, b, strong')) {
      if (node.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) continue;
      if (!isBareAsteriskNode(node)) continue;
      const host = node.parentElement || node;
      if (resolveAsteriskQuestionFromNode(node) || resolveAsteriskQuestionFromNode(host)) {
        set.add(isBareAsteriskNode(node) && node.previousElementSibling ? node : host);
      }
    }
    return Array.from(set);
  }

    /**
   * Document-order: first suitable control after this label, before the next * question.
   * Catches Ashby layouts where label/control are not simple siblings.
   */
  function findControlInDocumentOrder(labelNode) {
    if (!labelNode || !document.body) return null;
    const qLabel = resolveAsteriskQuestionFromNode(labelNode) || '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
    walker.currentNode = labelNode;
    let best = null;
    let bestKind = 0;
    let steps = 0;
    let n = walker.nextNode();
    while (n && steps < 120) {
      steps += 1;
      if (n.closest?.('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) {
        n = walker.nextNode();
        continue;
      }
      // Hit a later *-question → stop (don't steal its controls)
      if (n !== labelNode && !labelNode.contains(n) && isNextAsteriskQuestionBoundary(n)) {
        const qHere = resolveAsteriskQuestionFromNode(n) || '';
        if (
          qHere &&
          qLabel &&
          normalizeLabel(qHere).toLowerCase() !== normalizeLabel(qLabel).toLowerCase() &&
          !questionsRoughlyMatch(qHere, qLabel)
        ) {
          break;
        }
      }

      const tag = (n.tagName || '').toLowerCase();
      const type = (n.type || '').toLowerCase();
      const role = (n.getAttribute?.('role') || '').toLowerCase();
      const isInput =
        tag === 'textarea' ||
        tag === 'select' ||
        (tag === 'input' && !['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type));
      const isCombo = role === 'combobox' || isComboboxLike(n);
      const text =
        /^(button|a|label)$/i.test(tag) || role === 'button' || role === 'radio'
          ? clickableText(n)
          : '';
      const isYesNo = /^(yes|y|no|n)$/i.test(text);

      if (!isInput && !isCombo && !isYesNo && type !== 'radio' && role !== 'radio') {
        n = walker.nextNode();
        continue;
      }
      if (!labelNode.contains(n) && !controlFollowsLabel(labelNode, n)) {
        n = walker.nextNode();
        continue;
      }
      if (!isFieldCollectible(n) && !isVisible(n) && !isChoiceGeometricallyVisible(n)) {
        if (type !== 'radio' && type !== 'checkbox' && role !== 'radio') {
          n = walker.nextNode();
          continue;
        }
      }

      let kind = 1;
      if (tag === 'textarea' || (tag === 'input' && !['radio', 'checkbox'].includes(type))) kind = 5;
      else if (tag === 'select' || isCombo) kind = 4;
      else if (isYesNo || type === 'radio' || role === 'radio') kind = 3;
      else kind = 2;

      if (kind > bestKind) {
        bestKind = kind;
        best = n;
        if (kind >= 5) break;
      }
      n = walker.nextNode();
    }
    return best;
  }
  /**
   * Scan the page for labels with * and bind them to the nearest control.
   * Rule: any prompt containing "*" is an application question.
   */
  function collectAsteriskLabeledFields(seenQuestionKeys) {
    const out = [];
    const usedControls = new Set();
    const labelNodes = harvestAsteriskLabelNodes();

    for (const node of labelNodes) {
      if (node.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) continue;
      if (isAtsHelperNote(node.innerText || '')) continue;

      const question = resolveAsteriskQuestionFromNode(node);
      if (!question || question.length < 2 || question.length > 800) continue;
      if (isEeSectionHeader(question) || isLikelyOptionLabel(question) || isAtsHelperNote(question)) {
        continue;
      }

      // Skip giant wrappers (whole form sections)
      const nestedControls = node.querySelectorAll(
        'input:not([type="hidden"]), textarea, select, button'
      ).length;
      if (nestedControls > 8) continue;

      // Prefer leaf labels: skip wrappers whose child already carries the full "*"-question
      const childOwnsQuestion = Array.from(node.children || []).some((c) => {
        if (isBareAsteriskNode(c)) return false;
        const ct = resolveAsteriskQuestionFromNode(c);
        return ct.length >= 3 && ct.length >= question.length * 0.6;
      });
      if (childOwnsQuestion) continue;

      const qk = question
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (!qk || seenQuestionKeys.has(qk)) continue;

      const sponsorship = isSponsorshipQuestion(question);
      const textControl = findTextControlAfterLabel(node) || null;

      // Document-order fallback when sibling walk misses Ashby layouts
      const docControl = findControlInDocumentOrder(node);

      if (sponsorship && textControl && !usedControls.has(textControl)) {
        usedControls.add(textControl);
        seenQuestionKeys.add(qk);
        out.push({
          id: textControl.name || textControl.id || `star_${qk.slice(0, 32).replace(/\W+/g, '_')}`,
          question,
          tag: textControl.tagName.toLowerCase(),
          type: isComboboxLike(textControl)
            ? 'combobox'
            : (textControl.type || textControl.tagName).toLowerCase(),
          placeholder: textControl.getAttribute?.('placeholder') || '',
          element: textControl,
          required: true,
        });
        continue;
      }

      // 1) Custom Yes/No buttons scoped to THIS field only
      let pair = findYesNoAfterLabel(node);
      if (!pair && docControl) {
        // Try pairing from the document-order hit's parent
        const root = docControl.parentElement || docControl;
        const clickables = choiceClickables(root.parentElement || root);
        const yesBtn = clickables.find((el) => /^(yes|y)$/i.test(clickableText(el)));
        if (yesBtn) pair = findYesNoPairFor(yesBtn, clickables);
      }
      if (
        pair?.yes &&
        pair?.no &&
        !usedControls.has(pair.yes) &&
        !usedControls.has(pair.no) &&
        (controlFollowsLabel(node, pair.yes) || node.contains(pair.yes))
      ) {
        usedControls.add(pair.yes);
        usedControls.add(pair.no);
        seenQuestionKeys.add(qk);
        const slug = qk.replace(/[^a-z0-9]+/g, '_').slice(0, 48);
        out.push({
          id: `choice_${slug}`,
          question,
          tag: 'choice',
          type: 'choice-button',
          placeholder: '',
          element: pair.yes.parentElement || node,
          options: { yes: pair.yes, no: pair.no },
          required: true,
        });
        continue;
      }

      // 2) Native radio Yes/No scoped to THIS field only
      const radioGroup = findNativeYesNoRadiosAfterLabel(node);
      if (
        radioGroup?.length >= 2 &&
        !usedControls.has(radioGroup[0]) &&
        (controlFollowsLabel(node, radioGroup[0]) || node.contains(radioGroup[0]))
      ) {
        radioGroup.forEach((r) => usedControls.add(r));
        seenQuestionKeys.add(qk);
        const optionLabels = radioGroup
          .map((r) => optionLabel(r) || r.value || '')
          .filter(Boolean);
        out.push({
          id: radioGroup[0].name || radioGroup[0].id || `radio_${qk.slice(0, 32).replace(/\W+/g, '_')}`,
          question,
          tag: 'input',
          type: 'radio',
          placeholder: '',
          element: radioGroup[0],
          options: optionLabels.length ? optionLabels : ['Yes', 'No'],
          required: true,
        });
        continue;
      }

      // 3) Nearby text / textarea / select / combobox (sibling walk + document order)
      let control = textControl || findControlAfterLabel(node) || docControl;
      // If docControl was a Yes/No button but pair failed, try its text sibling
      if (control && /^(yes|y|no|n)$/i.test(clickableText(control))) {
        control = textControl || findControlAfterLabel(node) || null;
      }
      if (control && !usedControls.has(control)) {
        if (!isFieldCollectible(control) && !isVisible(control) && !isChoiceGeometricallyVisible(control)) {
          /* still try radios */
        } else if (controlFollowsLabel(node, control) || node.contains(control)) {
          const type = (control.type || control.tagName).toLowerCase();
          if (!SKIP_TYPES.has(type) || control.getAttribute?.('role') === 'combobox') {
            if (type === 'radio') {
              const group = radiosInGroup(control);
              group.forEach((r) => usedControls.add(r));
            } else {
              usedControls.add(control);
            }
            seenQuestionKeys.add(qk);
            const fieldType = isComboboxLike(control)
              ? 'combobox'
              : type === 'radio' || type === 'checkbox'
                ? type
                : (control.getAttribute?.('role') === 'combobox' && 'combobox') ||
                  type ||
                  control.tagName.toLowerCase();
            out.push({
              id: control.name || control.id || `star_${qk.slice(0, 32).replace(/\W+/g, '_')}`,
              question,
              tag: control.tagName.toLowerCase(),
              type: fieldType,
              placeholder: control.getAttribute?.('placeholder') || '',
              element: control,
              required: true,
            });
            continue;
          }
        }
      }

      // 4) Still list the *-question even if we couldn't bind a control yet
      //    so the progress board / generate pass sees every required prompt
      seenQuestionKeys.add(qk);
      const slug = qk.replace(/[^a-z0-9]+/g, '_').slice(0, 48);
      out.push({
        id: `star_orphan_${slug}`,
        question,
        tag: 'label',
        type: 'unbound',
        placeholder: '',
        element: node,
        required: true,
      });
    }
    return out;
  }

  /** Tight roots: following siblings only — never the whole form/fieldset. */
  function collectSearchRootsAfterLabel(labelNode) {
    const searchRoots = [];
    let sib = labelNode.nextElementSibling;
    for (let i = 0; i < 8 && sib; i++) {
      if (isNextAsteriskQuestionBoundary(sib)) break;
      searchRoots.push(sib);
      sib = sib.nextElementSibling;
    }
    // Immediate parent only when it is a small field wrapper (not form/fieldset)
    const parent = labelNode.parentElement;
    if (parent) {
      const tag = parent.tagName;
      const nested = parent.querySelectorAll(
        'input:not([type="hidden"]), textarea, select'
      ).length;
      if (tag !== 'FORM' && tag !== 'BODY' && tag !== 'MAIN' && nested > 0 && nested <= 4) {
        searchRoots.push(parent);
      }
    }
    const wrap = labelNode.closest(
      '[class*="field"], [class*="Field"], [class*="form-group"], [class*="FormField"], [data-testid*="field"]'
    );
    if (wrap && wrap !== parent && !searchRoots.includes(wrap)) {
      const nested = wrap.querySelectorAll(
        'input:not([type="hidden"]), textarea, select'
      ).length;
      // Reject wrappers that contain many questions
      if (nested > 0 && nested <= 4) searchRoots.push(wrap);
    }
    return searchRoots;
  }

  function findYesNoAfterLabel(labelNode) {
    for (const root of collectSearchRootsAfterLabel(labelNode)) {
      if (!root) continue;
      const clickables = choiceClickables(root).filter((el) => controlFollowsLabel(labelNode, el));
      const yesBtn = clickables.find((el) => /^(yes|y)$/i.test(clickableText(el)));
      if (!yesBtn) continue;
      const pair = findYesNoPairFor(yesBtn, clickables);
      if (pair) return pair;
    }
    return null;
  }

  /** Native <input type="radio"> Yes/No under THIS * label only. */
  function findNativeYesNoRadiosAfterLabel(labelNode) {
    for (const root of collectSearchRootsAfterLabel(labelNode)) {
      if (!root) continue;
      const radios = Array.from(root.querySelectorAll('input[type="radio"]')).filter(
        (el) =>
          (isFieldCollectible(el) || isVisible(el) || !!el.labels?.length) &&
          controlFollowsLabel(labelNode, el)
      );
      if (radios.length < 2) continue;

      const byName = new Map();
      for (const r of radios) {
        const key = r.name || `__anon_${r.id || radios.indexOf(r)}`;
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(r);
      }
      for (const group of byName.values()) {
        if (group.length < 2) continue;
        const labels = group.map((r) =>
          normalizeLabel(optionLabel(r) || r.value || '').toLowerCase()
        );
        const hasYes = labels.some((l) => /^(yes|y)$/i.test(l));
        const hasNo = labels.some((l) => /^(no|n)$/i.test(l));
        if (hasYes && hasNo) return group;
        if (group.length === 2) return group;
      }
    }
    return null;
  }

  /** Prefer text/textarea after a label (skips radio/checkbox). */
  function findTextControlAfterLabel(labelNode) {
    const pickText = (root) => {
      if (!root) return null;
      const nodes = root.matches?.(
        'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea'
      )
        ? [root]
        : Array.from(
            root.querySelectorAll?.(
              'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea'
            ) || []
          );
      for (const el of nodes) {
        if (!controlFollowsLabel(labelNode, el) && !labelNode.contains(el)) continue;
        if (!isFieldCollectible(el) && !isVisible(el)) continue;
        return el;
      }
      return null;
    };

    let sib = labelNode.nextElementSibling;
    for (let i = 0; i < 8 && sib; i++) {
      if (isNextAsteriskQuestionBoundary(sib)) break;
      const hit = pickText(sib);
      if (hit) return hit;
      sib = sib.nextElementSibling;
    }
    if (labelNode.tagName === 'LABEL' && labelNode.control) {
      const c = labelNode.control;
      const t = (c.type || '').toLowerCase();
      if (c.tagName === 'TEXTAREA' || (c.tagName === 'INPUT' && !['radio', 'checkbox', 'hidden', 'file'].includes(t))) {
        return c;
      }
    }
    const forId = labelNode.getAttribute?.('for');
    if (forId) {
      const byFor = document.getElementById(forId);
      if (byFor) {
        const t = (byFor.type || '').toLowerCase();
        if (
          byFor.tagName === 'TEXTAREA' ||
          (byFor.tagName === 'INPUT' && !['radio', 'checkbox', 'hidden', 'file'].includes(t))
        ) {
          return byFor;
        }
      }
    }
    const wrap = labelNode.closest(
      '[class*="field"], [class*="Field"], [class*="form-group"], [class*="FormField"], [data-testid*="field"]'
    );
    if (wrap) {
      const nested = wrap.querySelectorAll(
        'input:not([type="hidden"]), textarea, select'
      ).length;
      if (nested > 0 && nested <= 4) {
        const hit = pickText(wrap);
        if (hit) return hit;
      }
    }
    return pickText(labelNode.parentElement);
  }

  function findControlAfterLabel(labelNode) {
    if (labelNode.tagName === 'LABEL' && labelNode.control) return labelNode.control;
    const forId = labelNode.getAttribute?.('for');
    if (forId) {
      const byFor = document.getElementById(forId);
      if (byFor) return byFor;
    }

    const pick = (root) => {
      if (!root) return null;
      const el =
        root.matches?.(
          'input, textarea, select, [role="combobox"], [role="button"][aria-haspopup], [class*="select"], [class*="Select"]'
        )
          ? root
          : root.querySelector?.(
              'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, select, [role="combobox"], input[role="combobox"]'
            );
      if (!el) return null;
      if (el.getAttribute?.('role') === 'combobox' && el.tagName !== 'INPUT') {
        return el.querySelector('input') || el;
      }
      if (
        el.getAttribute?.('role') === 'button' ||
        /select|combobox|dropdown/i.test(String(el.className || ''))
      ) {
        const inner =
          el.querySelector?.(
            'input:not([type="hidden"]), [role="combobox"], textarea, select'
          ) || el;
        return inner;
      }
      return el;
    };

    const textFirst = findTextControlAfterLabel(labelNode);
    if (textFirst) return textFirst;

    const inside = pick(labelNode);
    if (inside && (labelNode.contains(inside) || controlFollowsLabel(labelNode, inside))) {
      return inside;
    }

    let sib = labelNode.nextElementSibling;
    for (let i = 0; i < 6 && sib; i++) {
      if (isNextAsteriskQuestionBoundary(sib)) break;
      const hit = pick(sib);
      if (hit && controlFollowsLabel(labelNode, hit)) return hit;
      sib = sib.nextElementSibling;
    }
    return null;
  }

  /** Collapse duplicate progress/fill rows that share the same question label. */
  HS.dedupeQuestionItems = function dedupeQuestionItems(items) {
    if (!Array.isArray(items) || !items.length) return [];
    const map = new Map();
    const rank = (src) => {
      const s = String(src || '');
      if (s === 'profile') return 5;
      if (s === 'remembered' || s === 'fixed' || s === 'saved') return 4;
      if (s === 'updated' || s === 'consent' || s === 'page') return 3;
      if (s === 'openai' || s === 'generated') return 2;
      if (s === 'unmatched' || s === 'todo' || s === 'needs_user') return 0;
      return 1;
    };
    for (const item of items) {
      if (!item) continue;
      if (item.id === '__resume__') {
        map.set('__resume__', item);
        continue;
      }
      const key =
        normalizeLabel(item.question || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim() || String(item.id || '');
      if (!key) continue;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, { ...item });
        continue;
      }
      const merged = { ...prev };
      if (item.filled || prev.filled) merged.filled = true;
      if (rank(item.source) >= rank(prev.source)) merged.source = item.source || prev.source;
      if (item.required || prev.required) merged.required = true;
      if (item.intent && !merged.intent) merged.intent = item.intent;
      // Prefer a stable id from the filled row
      if (item.filled && item.id) merged.id = item.id;
      map.set(key, merged);
    }
    return [...map.values()];
  };

  /** Committed value for Ashby/react-select style comboboxes (not the filter draft). */
  function comboboxCommittedValue(el) {
    if (!el) return '';
    const ariaVal = el.getAttribute('aria-valuetext');
    if (ariaVal && normalizeLabel(ariaVal)) return normalizeLabel(ariaVal);

    const ctrl = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (ctrl) {
      for (const id of String(ctrl).split(/\s+/)) {
        const box = document.getElementById(id);
        const selected = box?.querySelector?.(
          '[role="option"][aria-selected="true"], [role="option"][data-selected="true"]'
        );
        if (selected) {
          const t = normalizeLabel(selected.innerText || selected.getAttribute('aria-label') || '');
          if (t) return t;
        }
      }
    }

    const wrap =
      el.closest('[class*="select"], [class*="Select"], [class*="control"], [class*="combobox"]') ||
      el.parentElement;
    if (wrap) {
      const single = wrap.querySelector(
        '[class*="singleValue"], [class*="SingleValue"], [class*="value-container"] [class*="value"]:not(input), [data-value]'
      );
      if (single && !single.contains(el)) {
        const t = normalizeLabel(single.innerText || single.getAttribute('data-value') || '');
        if (t && t.length < 200) return t;
      }
    }

    // Expanded=false + non-empty value usually means selection committed
    if (el.getAttribute('aria-expanded') === 'false' && el.value) {
      return normalizeLabel(el.value);
    }
    return normalizeLabel(fieldValue(el));
  }

  function normalizeRememberedAnswer(answer) {
    let a = String(answer || '').trim();
    if (/decline\s+to\s+(self[- ]?identify|state|answer)/i.test(a)) a = 'Decline to state';
    return a;
  }

  /**
   * Resolve question + answer for a live form control (input / select / combobox / radio).
   * Used when the user edits a field so we can remember it for the next application.
   */
  /** Capture Yes/No from a custom choice-button click (Ashby segmented controls). */
  function captureChoiceButtonClick(el) {
    if (!el) return null;
    const btn =
      (el.closest &&
        el.closest(
          'button, a, label, [role="button"], [role="radio"], [role="option"], [data-value]'
        )) ||
      (/^(BUTTON|A|LABEL)$/i.test(el.tagName || '') ? el : null);
    if (!btn) return null;
    const text = clickableText(btn);
    if (!/^(yes|y|no|n)$/i.test(text)) return null;
    const answer = /^(yes|y)$/i.test(text) ? 'Yes' : 'No';

    let yesBtn = null;
    let noBtn = null;
    let container = btn.parentElement;
    for (let depth = 0; depth < 6 && container && (!yesBtn || !noBtn); depth++) {
      const clickables = choiceClickables(container);
      if (answer === 'Yes') {
        const pair = findYesNoPairFor(btn, clickables);
        if (pair) {
          yesBtn = pair.yes;
          noBtn = pair.no;
          break;
        }
      } else {
        const yes = clickables.find((e) => /^(yes|y)$/i.test(clickableText(e)));
        if (yes) {
          const pair = findYesNoPairFor(yes, clickables);
          if (pair && (pair.no === btn || pair.no.contains?.(btn) || btn.contains?.(pair.no))) {
            yesBtn = pair.yes;
            noBtn = pair.no;
            break;
          }
          // Same-parent No is good enough
          if (yes.parentElement === btn.parentElement) {
            yesBtn = yes;
            noBtn = btn;
            break;
          }
        }
      }
      container = container.parentElement;
    }

    if (!yesBtn || !noBtn) {
      const sibs = choiceClickables(btn.parentElement || document.body);
      const pair = findYesNoPair(sibs);
      if (!pair) return null;
      yesBtn = pair.yes;
      noBtn = pair.no;
    }

    const tight = yesBtn.parentElement || btn.parentElement;
    const question =
      choiceGroupQuestion(tight, yesBtn, noBtn) ||
      choiceGroupQuestion(tight?.parentElement || tight, yesBtn, noBtn);
    if (!question || question.length < 8) return null;

    return {
      question,
      answer,
      id: `choice_${question.slice(0, 24).replace(/\W+/g, '_')}`,
      tag: 'choice',
      type: 'choice-button',
    };
  }

  HS.captureAnswerFromElement = function captureAnswerFromElement(el) {
    if (!el || el.closest?.('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return null;
    // Work/education entries come from the resume — never learn them as fixed answers
    if (isHistoryField(el)) return null;

    // Custom Yes/No buttons (must run before input lookup — buttons aren't inputs)
    const choicePair = captureChoiceButtonClick(el);
    if (choicePair) return choicePair;

    // Click on a listbox option → bind to the open combobox
    if (el.getAttribute?.('role') === 'option' || el.closest?.('[role="option"]')) {
      const opt = el.getAttribute?.('role') === 'option' ? el : el.closest('[role="option"]');
      const combo =
        document.querySelector('input[role="combobox"][aria-expanded="true"]') ||
        document.querySelector('input[aria-autocomplete][aria-expanded="true"]') ||
        (document.activeElement?.tagName === 'INPUT' ? document.activeElement : null);
      if (combo) {
        if (isHistoryField(combo)) return null;
        const question =
          groupQuestionFor(combo) || labelFor(combo) || inferQuestionFromOptions([]);
        let answer = normalizeLabel(opt.innerText || opt.getAttribute('aria-label') || '');
        answer = normalizeRememberedAnswer(answer);
        if (!question || !answer) return null;
        if (HS.isCoverLetterField?.(question, { placeholder: combo.placeholder })) return null;
        return {
          question,
          answer,
          id: combo.name || combo.id || 'combobox',
          tag: 'input',
          type: 'combobox',
        };
      }
    }

    let node = el;
    if (!/^(INPUT|TEXTAREA|SELECT)$/i.test(node.tagName || '')) {
      node =
        el.closest?.('input, textarea, select') ||
        el.querySelector?.('input, textarea, select') ||
        null;
    }
    if (!node) return null;

    const type = (node.type || node.tagName).toLowerCase();
    if (SKIP_TYPES.has(type)) return null;

    if (type === 'radio') {
      if (!node.name) return null;
      const checked =
        document.querySelector(
          `input[type="radio"][name="${CSS.escape(node.name)}"]:checked`
        ) || (node.checked ? node : null);
      if (!checked) return null;
      const opts = radiosInGroup(checked).map((r) => optionLabel(r) || r.value || '');
      let question =
        groupQuestionFor(checked) || groupQuestionFor(node) || inferQuestionFromOptions(opts);
      if (question && (isEeSectionHeader(question) || isLikelyOptionLabel(question))) {
        question = inferQuestionFromOptions(opts);
      }
      let answer = normalizeRememberedAnswer(optionLabel(checked) || checked.value || 'Yes');
      if (!question || !answer || answer.length > 200) return null;
      return {
        question,
        answer,
        id: node.name || node.id || 'radio',
        tag: 'input',
        type: 'radio',
      };
    }

    if (type === 'checkbox') {
      if (!node.checked) return null;
      const question = groupQuestionFor(node) || labelFor(node);
      const answer = normalizeRememberedAnswer(optionLabel(node) || 'Yes');
      if (!question || !answer) return null;
      if (HS.isCoverLetterField?.(question, {})) return null;
      return {
        question,
        answer,
        id: node.name || node.id || 'checkbox',
        tag: 'input',
        type: 'checkbox',
      };
    }

    if (!isVisible(node)) return null;

    const isCombo = isComboboxLike(node) || node.getAttribute('role') === 'combobox';
    let question = isCombo || node.tagName === 'SELECT' ? groupQuestionFor(node) || labelFor(node) : labelFor(node);
    if (question && (isEeSectionHeader(question) || isLikelyOptionLabel(question))) {
      question = labelFor(node);
    }
    let answer =
      node.tagName === 'SELECT'
        ? fieldValue(node)
        : isCombo
          ? comboboxCommittedValue(node)
          : fieldValue(node);
    answer = normalizeRememberedAnswer(answer);

    if (!question || !answer) return null;
    if (HS.isCoverLetterField?.(question, { placeholder: node.placeholder || '' })) return null;
    // Skip long essays; keep short reusable answers + selectors
    if (node.tagName === 'TEXTAREA' && answer.length > 120) return null;
    if (answer.length > 220) return null;

    return {
      question,
      answer,
      id: node.name || node.id || `field_${question.slice(0, 24)}`,
      tag: node.tagName.toLowerCase(),
      type: isCombo ? 'combobox' : (node.type || node.tagName).toLowerCase(),
    };
  };

  HS.collectFilledAnswers = function collectFilledAnswers() {
    const pairs = [];
    const seenQ = new Set();

    // Prefer structured questions so labels match what we fill next time
    try {
      for (const q of HS.collectQuestions()) {
        if (HS.isCoverLetterField?.(q.question, q)) continue;
        let answer = '';
        let type = q.type || '';
        if (q.type === 'choice-button') {
          answer = choiceGroupValue(q);
        } else if (q.type === 'radio' && (q.ariaRadios?.length || q.element)) {
          if (q.ariaRadios?.length) {
            const checked = q.ariaRadios.find(
              (n) =>
                n.getAttribute('aria-checked') === 'true' ||
                /\b(selected|is-selected|checked|Mui-checked)\b/i.test(String(n.className || ''))
            );
            if (checked) {
              answer = clickableText(checked) || normalizeLabel(checked.innerText);
              type = 'radio';
            }
          } else if (q.element) {
            const pair = HS.captureAnswerFromElement(q.element);
            if (pair) {
              answer = pair.answer;
              type = 'radio';
            }
          }
        } else if (q.type === 'checkbox' && q.element) {
          answer = q.element.checked ? optionLabel(q.element) || 'Yes' : '';
        } else if ((q.type === 'combobox' || isComboboxLike(q.element)) && q.element) {
          answer = comboboxCommittedValue(q.element);
          type = 'combobox';
        } else if (q.element) {
          answer = fieldValue(q.element);
        }
        answer = normalizeRememberedAnswer(answer);
        if (!q.question || !answer) continue;
        if (q.tag === 'textarea' && answer.length > 120) continue;
        if (answer.length > 220) continue;
        const qk = q.question.toLowerCase();
        if (seenQ.has(qk)) continue;
        seenQ.add(qk);
        pairs.push({
          question: q.question,
          answer,
          id: q.id,
          tag: q.tag || 'input',
          type,
          options: serializableOptions(q.options),
        });
      }
    } catch (err) {
      console.warn('collectFilledAnswers via questions failed', err);
    }

    // Fallback sweep for any fields collectQuestions missed
    document.querySelectorAll('input, textarea, select').forEach((el) => {
      const pair = HS.captureAnswerFromElement(el);
      if (!pair) return;
      const qk = pair.question.toLowerCase();
      if (seenQ.has(qk)) return;
      seenQ.add(qk);
      pairs.push(pair);
    });

    return pairs;
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Push DOM value into React/Ashby form state without clearing or retyping.
   * Uses the native value setter + React's _valueTracker so onChange fires once.
   */
  function syncDomValueToFramework(el, value) {
    if (!el) return false;
    const str = value == null ? '' : String(value);
    const proto =
      el.tagName === 'SELECT'
        ? window.HTMLSelectElement.prototype
        : el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');

    // React controlled inputs ignore identical setter writes unless tracker differs
    try {
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === 'function') {
        tracker.setValue(str === '' ? ' ' : '');
      }
    } catch {
      /* ignore */
    }

    if (desc?.set) desc.set.call(el, str);
    else el.value = str;

    try {
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          composed: true,
          data: str,
          inputType: str ? 'insertText' : 'deleteContentBackward',
        })
      );
    } catch {
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return true;
  }

  function focusFieldQuiet(el) {
    if (!el) return;
    try {
      el.focus?.({ preventScroll: true });
    } catch {
      try {
        el.focus?.();
      } catch {
        /* ignore */
      }
    }
    try {
      el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    } catch {
      /* ignore */
    }
  }

  function blurFieldQuiet(el) {
    if (!el) return;
    try {
      el.blur?.();
    } catch {
      /* ignore */
    }
    try {
      el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    } catch {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  }

  /**
   * Write a value the way React / Ashby controlled fields expect — one sync, no clear/retype.
   */
  function setNativeValue(el, value, { blur = true, focus = true } = {}) {
    if (!el) return;
    const str = value == null ? '' : String(value);
    if (focus) focusFieldQuiet(el);
    syncDomValueToFramework(el, str);
    if (blur) blurFieldQuiet(el);
  }

  /**
   * One quiet commit: focus → sync existing/new value into framework state → blur.
   * No click(), no scroll jumps, no clear-then-retype, no double input pulses.
   */
  async function commitTextField(el, value) {
    if (!el) return false;
    const str = String(value ?? '');
    focusFieldQuiet(el);
    syncDomValueToFramework(el, str);
    // One frame so listeners flush before blur marks the field touched
    await settleUi(16);
    blurFieldQuiet(el);
    return String(el.value || '').trim().length > 0 || str === '';
  }

  /**
   * Touch a field that already shows text — commit DOM → React without rewriting content.
   */
  async function commitExistingFieldState(el) {
    if (!el) return false;
    const str = String(el.value || '');
    if (!str.trim()) return false;
    focusFieldQuiet(el);
    syncDomValueToFramework(el, str);
    await settleUi(8);
    blurFieldQuiet(el);
    return true;
  }

  /** Ashby / Greenhouse / React-Select style searchable dropdowns. */
  function isComboboxLike(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const type = (el.type || 'text').toLowerCase();
    if (!['text', 'search', ''].includes(type)) return false;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'combobox' || role === 'searchbox') return true;
    if (el.getAttribute('aria-autocomplete')) return true;
    if (el.getAttribute('aria-haspopup') === 'listbox') return true;
    if (el.getAttribute('aria-expanded') != null) return true;
    if (el.getAttribute('aria-controls') || el.getAttribute('aria-owns')) return true;
    const wrap = el.closest(
      '[class*="select"], [class*="Select"], [class*="combobox"], [class*="Combobox"], [class*="dropdown"], [data-testid*="select"], [class*="ashby"]'
    );
    if (wrap) return true;
    // Chevron / clear icons next to a short field often mean dropdown
    const parent = el.parentElement;
    if (
      parent &&
      parent.querySelector(
        'svg, [class*="chevron"], [class*="arrow"], [class*="indicator"], [aria-label*="clear" i]'
      )
    ) {
      return true;
    }
    return false;
  }

  /**
   * Infer Yes / No / Decline polarity from free-text or short answers.
   * Long AI sentences like "No, I am not a government official…" → 'no'.
   */
  function inferAnswerPolarity(answer) {
    const a = String(answer || '').trim();
    if (!a) return null;
    if (/decline\s+to|prefer\s+not|do\s+not\s+wish|rather\s+not|not\s+say|self[- ]?identify/i.test(a)) {
      // Decline phrases that are not clearly Yes/No
      if (!/^(yes|no)\b/i.test(a)) return 'decline';
    }
    if (/^(yes|y)\b/i.test(a)) return 'yes';
    if (/^(no|n)\b/i.test(a)) return 'no';
    // "I am not…" / "I'm not…" / "not a …"
    if (
      /\b(i\s+am\s+not|i'?m\s+not|not\s+a\s+|do\s+not\s+have|don't\s+have|have\s+never|never\s+been)\b/i.test(
        a
      )
    ) {
      return 'no';
    }
    if (/\b(i\s+am\s+a|i'?m\s+a|i\s+have\s+a|i\s+do\s+have|yes[, ]+i)\b/i.test(a)) return 'yes';
    if (/^(true|1|checked)$/i.test(a)) return 'yes';
    if (/^(false|0|unchecked)$/i.test(a)) return 'no';
    return null;
  }

  /** Short filter strings that searchable dropdowns can match against option lists. */
  function shortFilterCandidates(answer, question) {
    const polarity = inferAnswerPolarity(answer);
    const out = [];
    if (polarity === 'yes') out.push('Yes', 'Y');
    if (polarity === 'no') out.push('No', 'N');
    if (polarity === 'decline') out.push('Decline', 'Prefer not', 'Prefer');
    const raw = String(answer || '').trim();
    // First short clause before comma / em-dash (often "No" or "Yes")
    const head = raw.split(/[,—–-]/)[0].trim();
    if (head && head.length <= 24) out.push(head);
    if (raw && raw.length <= 24) out.push(raw);
    // Prefer polarity shorts for EE / government-style yes-no questions
    const q = String(question || '');
    if (
      polarity &&
      /official|relative|sponsor|authoriz|veteran|disability|hispanic|gender|race|eligible|work\b/i.test(
        q
      )
    ) {
      return [...new Set(out.filter(Boolean))];
    }
    return [...new Set(out.filter(Boolean))];
  }

  /** Expand Yes/No into the real ATS option labels for common EE questions. */
  function expandAnswerCandidates(answer, question) {
    const a = String(answer || '').trim();
    const q = String(question || '').toLowerCase();
    const polarity = inferAnswerPolarity(a);
    const out = [];
    if (a) out.push(a);
    // Always add short Yes/No so combobox filters don't use the essay text
    if (polarity === 'yes') out.push('Yes', 'Y');
    if (polarity === 'no') out.push('No', 'N');
    if (polarity === 'decline') {
      out.push('Decline to self-identify', 'Prefer not to say', 'Decline to state', 'Decline');
    }

    if (/veteran/i.test(q)) {
      if (polarity === 'no' || /not a (protected )?veteran/i.test(a)) {
        out.push(
          'I am not a protected veteran',
          'No, I am not a protected veteran',
          'I am not a veteran',
          'Not a protected veteran',
          'No'
        );
      } else if (polarity === 'yes' || /protected veteran/i.test(a)) {
        out.push(
          'I identify as one or more of the classifications of a protected veteran',
          'Yes, I am a veteran',
          'I am a protected veteran',
          'Yes'
        );
      } else if (polarity === 'decline' || /decline|prefer not/i.test(a)) {
        out.push("I don't wish to answer", 'Decline to self-identify', 'Prefer not to say', a);
      }
    }

    if (/hispanic|latino/i.test(q)) {
      if (polarity === 'no') out.push('No');
      if (polarity === 'yes') out.push('Yes');
      if (polarity === 'decline' || /decline|prefer not/i.test(a)) {
        out.push('Decline to self-identify', 'Prefer not to say');
      }
    }

    if (
      /sponsor|authorized|eligible to work|work in the us|legally authorized|government official|close relative|public office|civil service/i.test(
        q
      )
    ) {
      if (polarity === 'yes') out.push('Yes');
      if (polarity === 'no') out.push('No');
    }

    if (/disability/i.test(q)) {
      if (polarity === 'no') out.push('No, I do not have a disability', 'No');
      if (polarity === 'yes') out.push('Yes, I have a disability', 'Yes');
      if (polarity === 'decline' || /decline|prefer not/i.test(a)) {
        out.push('I do not want to answer', 'Decline to self-identify', 'Prefer not to say');
      }
    }

    // Put short polarity tokens first so callers that take candidates[0] stay safe
    const shorts = shortFilterCandidates(a, question);
    return [...new Set([...shorts, ...out].filter(Boolean))];
  }

  function optionMatchScore(want, optionText) {
    const a = String(want || '')
      .toLowerCase()
      .trim();
    const h = String(optionText || '')
      .toLowerCase()
      .trim();
    if (!a || !h) return 0;
    if (a === h) return 100;
    if (/^(yes|no)$/i.test(a) && a === h) return 100;

    const wantPol = inferAnswerPolarity(a);
    const optPol = inferAnswerPolarity(h);
    // Long "No, I am not…" vs option "No"
    if (wantPol && optPol && wantPol === optPol) {
      if (/^(yes|no)$/i.test(h)) return 98;
      if (h.length <= 48) return 90;
    }
    // Avoid matching "No" answer to a "Yes, …" option
    if (wantPol && optPol && wantPol !== optPol && wantPol !== 'decline' && optPol !== 'decline') {
      return 0;
    }

    // Veteran: profile "No" → "I am not a protected veteran"
    if (/^(no|n)$/i.test(a) && /not a (protected )?veteran|i am not a veteran/i.test(h)) return 96;
    if (
      /^(yes|y)$/i.test(a) &&
      /protected veteran|i identify as|i am a (protected )?veteran/i.test(h) &&
      !/\bnot a\b/i.test(h)
    ) {
      return 92;
    }

    if (answersMatch(a, h)) return 75;
    if (h.startsWith(a) && a.length >= 2) return 60;
    // Option text contained in long answer ("No" inside "No, I am not…")
    if (h.length >= 2 && h.length <= 40 && a.includes(h) && /^(yes|no)\b/i.test(h)) return 88;
    if (a.length >= 3 && h.includes(a)) return 45;
    return 0;
  }

  function findOpenListboxOptions(input) {
    const found = [];
    const push = (node) => {
      if (!node || found.includes(node)) return;
      const t = normalizeLabel(node.innerText || node.getAttribute?.('aria-label') || '');
      if (!t || t.length > 240) return;
      if (/^(type here|search|select|choose)$/i.test(t)) return;
      // Prefer visible options; portals may report 0 size briefly — still allow role=option
      const role = (node.getAttribute?.('role') || '').toLowerCase();
      if (!isVisible(node) && role !== 'option') return;
      found.push(node);
    };

    const ctrl = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
    if (ctrl) {
      String(ctrl)
        .split(/\s+/)
        .forEach((id) => {
          const box = document.getElementById(id);
          if (!box) return;
          box
            .querySelectorAll('[role="option"], li, [data-value], [class*="option"]')
            .forEach(push);
        });
    }

    document.querySelectorAll('[role="listbox"]').forEach((box) => {
      box.querySelectorAll('[role="option"], li').forEach(push);
    });

    // Portaled menus (Ashby / react-select)
    document
      .querySelectorAll(
        '[class*="menu"] [role="option"], [class*="Menu"] [role="option"], [class*="option-list"] [role="option"], [id*="react-select"] [role="option"], [class*="dropdown"] [role="option"]'
      )
      .forEach(push);

    // Nearby visible options under the same field wrapper
    const wrap =
      input.closest('[class*="field"], [class*="Field"], [class*="select"], form, section, label') ||
      input.parentElement;
    wrap
      ?.querySelectorAll?.('[role="option"], [class*="option"]:not(input):not(textarea)')
      .forEach(push);

    return found;
  }

  function clickOption(node) {
    if (!node) return false;
    try {
      node.scrollIntoView?.({ block: 'nearest' });
    } catch {
      /* ignore */
    }
    const events = ['pointerdown', 'mousedown', 'mouseup', 'click'];
    for (const type of events) {
      try {
        node.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
        );
      } catch {
        /* ignore */
      }
    }
    try {
      node.click();
    } catch {
      /* ignore */
    }
    return true;
  }

  function fireKey(el, key, keyCode) {
    const opts = {
      key,
      code: key === 'Enter' ? 'Enter' : key === 'ArrowDown' ? 'ArrowDown' : key,
      keyCode: keyCode || (key === 'Enter' ? 13 : key === 'ArrowDown' ? 40 : 0),
      which: keyCode || (key === 'Enter' ? 13 : key === 'ArrowDown' ? 40 : 0),
      bubbles: true,
      cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function pickBestOption(options, candidates, { minScore = 40 } = {}) {
    let best = null;
    let bestScore = 0;
    for (const node of options) {
      const text = normalizeLabel(node.innerText || node.getAttribute('aria-label') || '');
      if (!text || /^(no options?|no results?|type to search|search)$/i.test(text)) continue;
      for (const c of candidates) {
        const score = optionMatchScore(c, text);
        // Prefer longer concrete labels (veteran phrasing) over a bare "No"
        const bonus = text.length > 12 && /veteran|disability|hispanic/i.test(text) ? 3 : 0;
        const total = score + bonus;
        if (total > bestScore) {
          bestScore = total;
          best = node;
        }
      }
    }
    return bestScore >= minScore ? best : null;
  }

  function optionNodeText(node) {
    return normalizeLabel(node?.innerText || node?.getAttribute?.('aria-label') || '');
  }

  /** Type a short filter into a combobox input (never paste essay answers). */
  function typeComboboxFilter(el, filterText) {
    const text = String(filterText || '').trim();
    setNativeValue(el, '', { blur: false });
    if (!text) return;
    setNativeValue(el, text, { blur: false });
    try {
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })
      );
    } catch {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function comboboxLooksCommitted(el, candidates) {
    const shown = normalizeLabel(
      el.value ||
        el.getAttribute('aria-valuetext') ||
        el.closest('[class*="select"], [class*="control"]')?.innerText ||
        ''
    ).toLowerCase();
    if (!shown) return false;
    // Still filtering / menu open with typed fragment only
    if (el.getAttribute('aria-expanded') === 'true' && shown.length <= 3) return false;
    return candidates.some((c) => {
      const cl = c.toLowerCase();
      if (shown === cl) return true;
      if (optionMatchScore(c, shown) >= 70) return true;
      // Committed veteran label visible in the control
      if (/not a (protected )?veteran/i.test(shown) && /^(no|n)$/i.test(c)) return true;
      return false;
    });
  }

  async function fillCombobox(el, answer, question) {
    const candidates = expandAnswerCandidates(answer, question);
    if (!candidates.length) return false;
    const filters = shortFilterCandidates(answer, question);

    try {
      el.focus();
    } catch {
      /* ignore */
    }
    // Open the menu
    try {
      el.click();
    } catch {
      /* ignore */
    }
    const opener =
      el.closest('[class*="control"], [class*="select"], [role="combobox"]') || el.parentElement;
    if (opener && opener !== el) {
      try {
        opener.click();
      } catch {
        /* ignore */
      }
    }
    await sleep(80);

    // 1) Open full list first (empty filter) so we can score real options
    typeComboboxFilter(el, '');
    fireKey(el, 'ArrowDown', 40);
    await sleep(140);

    let options = findOpenListboxOptions(el);
    if (!options.length) {
      fireKey(el, 'ArrowDown', 40);
      await sleep(120);
      options = findOpenListboxOptions(el);
    }

    let best = pickBestOption(options, candidates);

    // 2) If needed, filter with SHORT Yes/No (never the essay sentence)
    if (!best && filters.length) {
      for (const filterText of filters) {
        typeComboboxFilter(el, filterText);
        fireKey(el, 'ArrowDown', 40);
        await sleep(140);
        options = findOpenListboxOptions(el);
        best = pickBestOption(options, candidates);
        if (best) break;
      }
    }

    // 3) If we matched an option, re-filter by that option's short label then click
    if (best) {
      const optLabel = optionNodeText(best);
      const shortOpt =
        filters.find((f) => optionMatchScore(f, optLabel) >= 70) ||
        (optLabel.length <= 32 ? optLabel : filters[0] || '');
      if (shortOpt) {
        typeComboboxFilter(el, shortOpt);
        await sleep(100);
        const refined = findOpenListboxOptions(el);
        const again = pickBestOption(refined, candidates) || pickBestOption(refined, [optLabel, ...candidates]);
        if (again) best = again;
      }
      clickOption(best);
      await sleep(80);
      if (comboboxLooksCommitted(el, candidates) || el.getAttribute('aria-expanded') === 'false') {
        el.classList.add('hs-filled');
        return true;
      }
      // Some UIs need Enter after highlight
      fireKey(el, 'Enter', 13);
      await sleep(60);
      if (comboboxLooksCommitted(el, candidates) || el.getAttribute('aria-expanded') !== 'true') {
        el.classList.add('hs-filled');
        return true;
      }
    }

    // Last resort: short filter + ArrowDown + Enter (still never essay text)
    const fallbackFilter = filters[0] || '';
    if (fallbackFilter) {
      typeComboboxFilter(el, fallbackFilter);
      await sleep(80);
    }
    fireKey(el, 'ArrowDown', 40);
    await sleep(40);
    fireKey(el, 'Enter', 13);
    await sleep(80);

    const ok =
      comboboxLooksCommitted(el, candidates) ||
      (el.getAttribute('aria-expanded') === 'false' &&
        !!String(el.value || '').trim() &&
        !/select\.{0,3}/i.test(el.value || ''));
    if (ok) el.classList.add('hs-filled');
    // Clear leftover filter text if nothing committed (avoid "No options" residue)
    if (!ok) {
      typeComboboxFilter(el, '');
      try {
        el.blur?.();
      } catch {
        /* ignore */
      }
    }
    return ok;
  }

  function fillSelect(el, answer, question = '') {
    const candidates = expandAnswerCandidates(answer, question);
    const options = Array.from(el.options || []).filter((o) => {
      const t = String(o.text || '').trim();
      const v = String(o.value || '').trim();
      if (!t && !v) return false;
      if (/^select|choose|—|--$/i.test(t)) return false;
      return true;
    });
    if (!options.length || !candidates.length) return false;

    // Score native <option> nodes the same way as combobox list items
    let best = null;
    let bestScore = 0;
    for (const o of options) {
      const text = o.text || o.value || '';
      for (const c of candidates) {
        const score = optionMatchScore(c, text);
        if (score > bestScore) {
          bestScore = score;
          best = o;
        }
      }
    }

    // Gender / pronoun soft matches if polarity scoring missed
    if (!best || bestScore < 40) {
      const a = String(answer || '').toLowerCase().trim();
      const textOf = (o) => o.text.toLowerCase().trim();
      if (/^male$/i.test(a)) best = options.find((o) => /^(male|man|m)$/i.test(textOf(o))) || best;
      if (/^female$/i.test(a)) best = options.find((o) => /^(female|woman|f)$/i.test(textOf(o))) || best;
      if (/he\/him/i.test(a)) best = options.find((o) => /he\s*\/\s*him/i.test(textOf(o))) || best;
      if (/she\/her/i.test(a)) best = options.find((o) => /she\s*\/\s*her/i.test(textOf(o))) || best;
      if (/they\/them/i.test(a)) best = options.find((o) => /they\s*\/\s*them/i.test(textOf(o))) || best;
      if (best && bestScore < 40) bestScore = 50;
    }

    if (!best || bestScore < 40) return false;

    try {
      el.focus?.();
    } catch {
      /* ignore */
    }
    setNativeValue(el, best.value, { focus: true, blur: true });
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    try {
      el.blur?.();
    } catch {
      /* ignore */
    }
    return true;
  }

  /**
   * Quiet pass: sync every filled text/textarea into React state once.
   * Fixes "Missing entry for required field" on Submit without retyping or clicking.
   */
  async function retouchFilledTextFields() {
    const nodes = Array.from(document.querySelectorAll('input, textarea')).filter((el) => {
      if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return false;
      if (!isFieldCollectible(el)) return false;
      const type = (el.type || el.tagName).toLowerCase();
      if (['hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'image', 'reset'].includes(type)) {
        return false;
      }
      if (isComboboxLike(el)) return false;
      return String(el.value || '').trim().length > 0;
    });
    for (const el of nodes) {
      await commitExistingFieldState(el);
    }
    // Brief yield so the last blur lands before Submit
    await settleUi(30);
    return nodes.length;
  }

  function fillCheckbox(el, answer) {
    const a = String(answer || '').trim();
    const opt = optionLabel(el);
    // Single boolean checkbox (consent / acknowledge)
    const yes = /^(yes|y|true|1|checked)$/i.test(a);
    const no = /^(no|n|false|0|unchecked)$/i.test(a);
    if (yes || no) {
      activateToggle(el, yes);
      return yes ? !!el.checked : !el.checked;
    }
    // Multi-option checkbox: check if this option's label matches the answer
    if (answersMatch(a, opt) || answersMatch(a, el.value)) {
      activateToggle(el, true);
      return !!el.checked;
    }
    return false;
  }

  async function fillAriaRadios(nodes, answer, question) {
    const list = (nodes || []).filter((n) => n && document.contains(n));
    if (!list.length) return false;
    const candidates = expandAnswerCandidates(answer, question);
    let best = null;
    let bestScore = 0;
    for (const node of list) {
      const text = clickableText(node) || normalizeLabel(node.innerText);
      for (const c of candidates) {
        const score = optionMatchScore(c, text);
        if (score > bestScore) {
          bestScore = score;
          best = node;
        }
      }
    }
    if (!best || bestScore < 40) return false;
    if (best.getAttribute('aria-checked') === 'true') return true;
    clickOnce(best);
    await settleUi(80);
    if (best.getAttribute('aria-checked') === 'true') return true;
    // Some ATS only flip class / data-state
    clickOnce(best);
    await settleUi(60);
    return (
      best.getAttribute('aria-checked') === 'true' ||
      /\b(selected|is-selected|checked|Mui-checked)\b/i.test(String(best.className || ''))
    );
  }

  async function fillRadio(el, answer, q = null) {
    const a = String(answer || '').trim();
    if (!a) return false;

    if (q?.ariaRadios?.length) {
      return fillAriaRadios(q.ariaRadios, a, q.question || '');
    }
    if (el?.getAttribute?.('role') === 'radio') {
      const root =
        el.closest('[role="radiogroup"], fieldset, [role="group"]') || el.parentElement;
      const peers = Array.from(root?.querySelectorAll('[role="radio"]') || [el]);
      return fillAriaRadios(peers, a, q?.question || '');
    }

    let radios = radiosInGroup(el);
    if (!radios.length) radios = [el];

    const match = findBestRadioMatch(radios, a, q?.question || '');
    if (!match) return false;

    if (match.checked) return true;

    // Prefer clicking the visible control (label / custom button) — many ATS hide the input
    const visible = visibleRadioControl(match);
    if (visible) {
      clickOnce(visible);
      await settleUi(50);
      if (match.checked) return true;
    }

    activateToggle(match, true);
    await settleUi(40);
    if (match.checked) return true;

    // One more pass on label / for= control
    if (visible) clickOnce(visible);
    else {
      const lab =
        (match.labels && match.labels[0]) ||
        (match.id ? document.querySelector(`label[for="${CSS.escape(match.id)}"]`) : null) ||
        match.closest('label');
      if (lab) clickOnce(lab);
    }
    await settleUi(40);
    return !!match.checked;
  }

  /** Fill a set of checkboxes under one question (multi-select EE options). */
  function fillCheckboxGroup(seedEl, answer) {
    const a = String(answer || '').trim();
    // Boolean answers always target the seed control (consent / acknowledge)
    if (/^(yes|y|true|1|checked|no|n|false|0|unchecked)$/i.test(a)) {
      return fillCheckbox(seedEl, a);
    }

    const container =
      seedEl.closest('fieldset, [role="group"], form, section, div') || seedEl.parentElement;
    const boxes = Array.from(container?.querySelectorAll('input[type="checkbox"]') || []).filter(
      (b) => isVisible(b) || b === seedEl
    );
    if (boxes.length <= 1) return fillCheckbox(seedEl, a);

    const parts = a
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return fillCheckbox(seedEl, a);

    let any = false;
    for (const box of boxes) {
      const lab = optionLabel(box);
      const hit = parts.some((p) => answersMatch(p, lab) || answersMatch(p, box.value));
      if (hit) {
        activateToggle(box, true);
        any = any || !!box.checked;
      }
    }
    if (any) return true;
    return fillCheckbox(seedEl, a);
  }

  HS.isRequiredQuestion = function isRequiredQuestion(q) {
    const el = q?.element;
    const text = String(q?.question || '').toLowerCase();
    if (q?.required || q?.type === 'unbound') return true;
    if (el?.required || el?.getAttribute?.('aria-required') === 'true') return true;
    if (/\*/.test(q?.question || '') || hasRequiredAsterisk(q?.question || '')) return true;
    if (
      /optional|github|portfolio|website|twitter|cover letter|additional info|referral|how did you hear/i.test(
        text
      )
    ) {
      return false;
    }
    if (
      /name|email|phone|resume|cv|authorized|authorization|linkedin|address|city|country|work in|visa|sponsorship|legally|require/i.test(
        text
      )
    ) {
      return true;
    }
    if (q?.type === 'choice-button') return true;
    if (q?.tag === 'textarea') return true;
    return true;
  };

  /**
   * "I have read and agree…" / terms / privacy / certify — not marketing opt-ins.
   */
  function isConfirmationCheckbox(el, question) {
    if (!el || (el.type || '').toLowerCase() !== 'checkbox') return false;
    const blob = [
      question || '',
      optionLabel(el),
      labelFor(el),
      el.name || '',
      el.id || '',
      el.value || '',
      el.getAttribute('aria-label') || '',
      el.closest('label')?.innerText || '',
    ]
      .join(' ')
      .toLowerCase()
      .replace(/\s+/g, ' ');

    if (
      /newsletter|marketing|promotional|sms alerts?|text (me|messages?)|job alerts?|email me about|receive (emails?|updates)|opt[- ]?in to (email|sms)/i.test(
        blob
      )
    ) {
      return false;
    }

    return /\b(agree|agreement|terms(\s+and\s+conditions)?|conditions|privacy|policy|policies|consent|acknowledge|acknowledgment|certify|confirm that|i have read|i('ve| have) read|read and agree|attestation|accurate and complete|electronic\s*sign|e-?sign|waiver|code of conduct|nondiscrimination|equal opportunity|truthful|to the best of my knowledge)\b/i.test(
      blob
    );
  }

  HS.isConfirmationCheckbox = isConfirmationCheckbox;

  /** Check all visible confirmation / agree checkboxes on the page. */
  HS.checkConfirmationCheckboxes = function checkConfirmationCheckboxes() {
    let n = 0;
    document.querySelectorAll('input[type="checkbox"]').forEach((el) => {
      if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return;
      if (el.disabled) return;
      if (!isVisible(el) && !(el.labels && el.labels.length)) return;
      const question = groupQuestionFor(el) || labelFor(el);
      if (!isConfirmationCheckbox(el, question)) return;
      if (el.checked) {
        el.classList.add('hs-filled');
        n += 1;
        return;
      }
      activateToggle(el, true);
      if (el.checked) {
        el.classList.add('hs-filled');
        n += 1;
      }
    });
    return n;
  };

  HS.fillAnswers = async function fillAnswers(answers, opts = {}) {
    const onItem = typeof opts.onItem === 'function' ? opts.onItem : null;
    const list = Array.isArray(answers) ? answers : [];
    const byId = new Map(list.map((a) => [a.id, a]));
    const byQuestion = new Map(
      list.map((a) => [normalizeLabel(a.question || '').toLowerCase(), a])
    );

    const questions = HS.collectQuestions();
    let filled = 0;
    const items = [];
    const handledConsent = new Set();

    for (const q of questions) {
      const rec = findAnswerRecord(q, list, byId, byQuestion);
      const intent =
        rec?.intent || guessQuestionIntent(q.question) || null;
      const isSponsorship =
        intent === 'sponsorship' || isSponsorshipQuestion(q.question);
      // Hard rule: sponsorship is always No — never leave blank waiting on API match
      let answer = isSponsorship ? 'No' : rec?.answer;
      const source = isSponsorship
        ? rec?.source || 'remembered'
        : rec?.source || null;
      const required = HS.isRequiredQuestion(q);
      let ok = false;
      let fillSource = source;

      const el = q.element;
      if (q.type === 'choice-button') {
        // Bind to the Yes/No pair for THIS question label (not a neighbor group)
        const pair = resolveChoicePair(q);
        if (pair) q.options = pair;
        const already = choiceGroupValue(q);

        if (isSponsorship) {
          ok = await forceSponsorshipNo(q);
          fillSource = fillSource || 'remembered';
        } else if (answer != null && answer !== '') {
          ok = await fillChoiceButtons(q, String(answer));
          // Trust fillChoiceButtons' own pair — do NOT re-resolve to a neighbor
          if (!ok && already) {
            const wantYes = /^(yes|y|true|1)$/i.test(String(answer).trim());
            const wantNo = /^(no|n|false|0)$/i.test(String(answer).trim());
            if ((wantYes && already === 'Yes') || (wantNo && already === 'No')) ok = true;
          }
        } else if (already) {
          ok = true;
          fillSource = fillSource || 'page';
        }
        if (ok) {
          filled += 1;
          el?.classList?.add('hs-filled');
        }
      } else if (q.type === 'unbound') {
        // *-label found without a bound control — re-resolve at fill time
        const labelNode = el;
        if (isSponsorship) {
          ok = await forceSponsorshipNo({
            question: q.question,
            type: 'choice-button',
            element: labelNode,
          });
          fillSource = fillSource || 'remembered';
        } else if (answer != null && answer !== '' && labelNode) {
          let pair = findYesNoAfterLabel(labelNode);
          if (pair?.yes && pair?.no) {
            ok = await fillChoiceButtons(
              {
                question: q.question,
                type: 'choice-button',
                element: pair.yes.parentElement || labelNode,
                options: pair,
              },
              String(answer)
            );
          }
          if (!ok) {
            const control =
              findTextControlAfterLabel(labelNode) ||
              findControlAfterLabel(labelNode) ||
              findControlInDocumentOrder(labelNode);
            if (control && control.tagName !== 'LABEL') {
              const type = (control.type || control.tagName).toLowerCase();
              if (type === 'radio') ok = await fillRadio(control, String(answer), q);
              else if (control.tagName === 'SELECT') {
                ok = fillSelect(control, String(answer), q.question);
              } else if (isComboboxLike(control) || control.getAttribute?.('role') === 'combobox') {
                ok = await fillCombobox(control, String(answer), q.question);
              } else if (!SKIP_TYPES.has(type)) {
                ok = await commitTextField(control, String(answer));
              }
              if (ok) control.classList?.add('hs-filled');
            }
          }
        }
        if (ok) filled += 1;
      } else if (
        el &&
        document.contains(el) &&
        answer != null &&
        answer !== '' &&
        !HS.isCoverLetterField?.(q.question, q)
      ) {
        if (q.type === 'checkbox') ok = fillCheckboxGroup(el, String(answer));
        else if (q.type === 'radio') ok = await fillRadio(el, String(answer), q);
        else if (el.tagName === 'SELECT') ok = fillSelect(el, String(answer), q.question);
        else if (q.type === 'combobox' || isComboboxLike(el)) {
          // Custom dropdowns need type + click the matching option (not just overwrite text)
          ok = await fillCombobox(el, String(answer), q.question);
          if (!ok) {
            // Fallback: still set text so the user sees the intended answer
            ok = await commitTextField(el, String(answer));
          }
        } else {
          // Text / email / textarea — commit into React form state (not just DOM .value)
          ok = await commitTextField(el, String(answer));
        }
        if (ok) {
          filled += 1;
          el.classList.add('hs-filled');
        }
      } else if (
        HS.isCoverLetterField?.(q.question, q) &&
        answer != null &&
        answer !== ''
      ) {
        // Explicitly skip cover letter — leave blank for the user
        ok = false;
        fillSource = 'skipped';
      } else if (
        el &&
        document.contains(el) &&
        q.type === 'checkbox' &&
        isConfirmationCheckbox(el, q.question)
      ) {
        // Treat "I have read and agree" as confirmed during autofill
        ok = fillCheckbox(el, 'Yes');
        if (ok) {
          filled += 1;
          fillSource = 'consent';
          el.classList.add('hs-filled');
          handledConsent.add(el);
        }
      } else if (el && fieldValue(el)) {
        ok = true;
        fillSource = fillSource || 'page';
        filled += 1;
      } else if (q.type === 'choice-button' && choiceGroupValue(q)) {
        ok = true;
        fillSource = 'page';
        filled += 1;
      }

      const item = {
        id: q.id,
        question: q.question,
        required,
        filled: ok,
        source: ok ? fillSource || source || null : source === 'unmatched' ? 'unmatched' : null,
        intent,
      };
      items.push(item);
      onItem?.(item, items);
    }

    // Second pass: choice buttons / radios that were locked on the first pass
    // (the unlock wait is only paid when something is actually left unfilled)
    if (items.some((it) => !it.filled && it.id !== '__resume__')) await settleUi(350);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.filled || item.id === '__resume__') continue;
      const q = questions.find((x) => x.id === item.id || x.question === item.question);
      if (!q) continue;
      const rec = findAnswerRecord(q, list, byId, byQuestion);
      const isSponsorship =
        item.intent === 'sponsorship' ||
        isSponsorshipQuestion(q.question) ||
        isSponsorshipQuestion(item.question);
      const answer = isSponsorship ? 'No' : rec?.answer;

      if (q.type === 'choice-button') {
        if (isSponsorship) {
          const ok = await forceSponsorshipNo(q);
          if (ok) {
            item.filled = true;
            item.source = rec?.source || item.source || 'remembered';
            item.intent = 'sponsorship';
            filled += 1;
            onItem?.(item, items);
          }
          continue;
        }
        if (answer == null || answer === '') {
          const pair = resolveChoicePair(q);
          if (pair) q.options = pair;
          const got = choiceGroupValue(q);
          if (got) {
            item.filled = true;
            item.source = item.source && item.source !== 'unmatched' ? item.source : 'page';
            filled += 1;
            onItem?.(item, items);
          }
          continue;
        }
        const ok = await fillChoiceButtons(q, String(answer));
        if (ok) {
          item.filled = true;
          item.source = rec?.source || item.source || 'profile';
          filled += 1;
          onItem?.(item, items);
        }
        continue;
      }

      if (q.type === 'radio' && answer != null && answer !== '' && q.element) {
        const ok = await fillRadio(q.element, String(answer), q);
        if (ok) {
          item.filled = true;
          item.source = rec?.source || item.source || 'profile';
          filled += 1;
          onItem?.(item, items);
        }
      }
    }

    // Final hard guarantee: every sponsorship Yes/No on the page → No
    if (findSponsorshipChoicePairs().length) {
      await settleUi(200);
      await forceAllSponsorshipNos();
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.filled) continue;
      if (
        item.intent === 'sponsorship' ||
        isSponsorshipQuestion(item.question)
      ) {
        const q = questions.find((x) => x.id === item.id || x.question === item.question);
        const ok = q ? await forceSponsorshipNo(q) : false;
        if (ok || findSponsorshipChoicePairs().some(sponsorshipPairSelectedNo)) {
          item.filled = true;
          item.source = item.source || 'remembered';
          item.intent = 'sponsorship';
          filled += 1;
          onItem?.(item, items);
        }
      }
    }

    // Sweep remaining agree/terms boxes not listed as collected questions
    document.querySelectorAll('input[type="checkbox"]').forEach((el, index) => {
      if (handledConsent.has(el)) return;
      if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return;
      if (el.disabled || el.checked) return;
      if (!isVisible(el) && !(el.labels && el.labels.length)) return;
      const question = groupQuestionFor(el) || labelFor(el);
      if (!isConfirmationCheckbox(el, question)) return;
      if (!fillCheckbox(el, 'Yes')) return;
      el.classList.add('hs-filled');
      filled += 1;
      const item = {
        id: el.name || el.id || `consent_${index}`,
        question: question || 'I agree / confirmation',
        required: true,
        filled: true,
        source: 'consent',
        intent: 'consent',
      };
      items.push(item);
      onItem?.(item, items);
    });

    // Touch all filled text/textarea so Submit validation sees React "touched" state
    await settleUi(150);
    await retouchFilledTextFields();

    const uniqueItems = HS.dedupeQuestionItems(items);
    return { filled, items: uniqueItems, total: uniqueItems.length };
  };

  /** Current fill state for each collected question (for live progress updates). */
  HS.getQuestionFillState = function getQuestionFillState() {
    return HS.collectQuestions().map((q) => {
      let filled = false;
      let value = '';
      if (q.type === 'choice-button') {
        value = choiceGroupValue(q);
        filled = !!value;
      } else if (q.ariaRadios?.length || (q.element?.getAttribute?.('role') === 'radio')) {
        const nodes =
          q.ariaRadios ||
          Array.from(
            (q.element.closest('[role="radiogroup"], fieldset, [role="group"]') || document).querySelectorAll(
              '[role="radio"]'
            )
          );
        const checked = nodes.find(
          (n) =>
            n.getAttribute('aria-checked') === 'true' ||
            /\b(selected|is-selected|checked|Mui-checked)\b/i.test(String(n.className || ''))
        );
        filled = !!checked;
        value = checked ? clickableText(checked) || normalizeLabel(checked.innerText) : '';
      } else if (q.element && document.contains(q.element)) {
        const el = q.element;
        const type = (el.type || '').toLowerCase();
        if (type === 'checkbox') {
          filled = !!el.checked;
          value = filled ? optionLabel(el) || 'Yes' : '';
        } else if (type === 'radio' || q.type === 'radio') {
          const group = el.name;
          const checked = group
            ? document.querySelector(
                `input[type="radio"][name="${CSS.escape(group)}"]:checked`
              )
            : el.checked
              ? el
              : null;
          filled = !!checked;
          value = checked ? optionLabel(checked) || checked.value || 'Yes' : '';
        } else if (q.type === 'combobox' || isComboboxLike(el)) {
          value = comboboxCommittedValue(el);
          filled = !!value && el.getAttribute('aria-expanded') !== 'true';
          if (!filled && value && value.length > 2) filled = true;
        } else {
          value = fieldValue(el);
          filled = !!value;
        }
      }
      return {
        id: q.id,
        question: q.question,
        filled,
        value: String(value || '').trim(),
        type: q.type || '',
      };
    });
  };

  /** Listen for user edits after autofill; debounced save + fast UI callback. */
  let answerWatchAbort = null;
  let answerWatchTimer = null;
  let answerWatchImmediateTimer = null;

  HS.stopAnswerLearning = function stopAnswerLearning() {
    if (answerWatchTimer) {
      clearTimeout(answerWatchTimer);
      answerWatchTimer = null;
    }
    if (answerWatchImmediateTimer) {
      clearTimeout(answerWatchImmediateTimer);
      answerWatchImmediateTimer = null;
    }
    answerWatchAbort?.abort();
    answerWatchAbort = null;
  };

  HS.startAnswerLearning = function startAnswerLearning(
    onChange,
    { debounceMs = 900, onImmediate = null, immediateMs = 180, onFieldChange = null } = {}
  ) {
    HS.stopAnswerLearning();
    if (
      typeof onChange !== 'function' &&
      typeof onImmediate !== 'function' &&
      typeof onFieldChange !== 'function'
    ) {
      return;
    }
    const ac = new AbortController();
    answerWatchAbort = ac;
    const pendingByQuestion = new Map();

    const noteField = (target) => {
      try {
        const text = normalizeLabel(
          target?.innerText ||
            target?.getAttribute?.('aria-label') ||
            target?.closest?.('button, [role="button"], [role="radio"]')?.innerText ||
            ''
        );
        const isYesNo = /^(yes|no|y|n)$/i.test(text);
        const isChoice =
          isYesNo ||
          !!target?.closest?.(
            '[role="radio"], [role="button"], [class*="choice"], [class*="toggle"]'
          );
        // Yes/No answer comes from the click label — no need to wait for styles.
        // Other custom controls need a short settle for aria/selection.
        const delay =
          target?.getAttribute?.('role') === 'option' || target?.closest?.('[role="option"]')
            ? 140
            : isYesNo
              ? 30
              : isChoice
                ? 220
                : 0;
        const run = () => {
          const pair = HS.captureAnswerFromElement?.(target);
          if (!pair?.question || !pair?.answer) return;
          pendingByQuestion.set(pair.question.toLowerCase(), pair);
          if (typeof onFieldChange === 'function') {
            try {
              onFieldChange(pair);
            } catch (err) {
              console.warn('onFieldChange failed', err);
            }
          }
        };
        if (delay) setTimeout(run, delay);
        else run();
      } catch (err) {
        console.warn('noteField failed', err);
      }
    };

    const schedule = (target) => {
      if (target) noteField(target);

      if (typeof onImmediate === 'function') {
        if (answerWatchImmediateTimer) clearTimeout(answerWatchImmediateTimer);
        const text = normalizeLabel(
          target?.innerText || target?.getAttribute?.('aria-label') || ''
        );
        const choiceDelay = /^(yes|no|y|n)$/i.test(text) ? Math.max(immediateMs, 280) : immediateMs;
        answerWatchImmediateTimer = setTimeout(() => {
          answerWatchImmediateTimer = null;
          try {
            onImmediate(HS.getQuestionFillState());
          } catch (err) {
            console.warn('Answer progress sync failed', err);
          }
        }, choiceDelay);
      }
      if (typeof onChange !== 'function') return;
      if (answerWatchTimer) clearTimeout(answerWatchTimer);
      answerWatchTimer = setTimeout(() => {
        answerWatchTimer = null;
        try {
          const collected = HS.collectFilledAnswers();
          // Merge just-edited fields so selector commits aren't lost
          const byQ = new Map(collected.map((p) => [String(p.question).toLowerCase(), p]));
          for (const [qk, pair] of pendingByQuestion) byQ.set(qk, pair);
          pendingByQuestion.clear();
          onChange([...byQ.values()]);
        } catch (err) {
          console.warn('Answer learning collect failed', err);
        }
      }, debounceMs);
    };

    const isOurUi = (t) =>
      !!(t && t.closest && t.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog'));

    const onInputish = (e) => {
      const t = e.target;
      if (!t || isOurUi(t)) return;
      const tag = (t.tagName || '').toUpperCase();
      const type = (t.type || '').toLowerCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (SKIP_TYPES.has(type)) return;
        schedule(t);
        return;
      }
      // Combobox option click
      if (t.getAttribute?.('role') === 'option' || t.closest?.('[role="option"]')) {
        schedule(t);
        return;
      }
      // Custom Yes/No buttons
      if (t.closest?.(CHOICE_SELECTOR) || t.getAttribute?.('role') === 'button' || tag === 'BUTTON') {
        const text = normalizeLabel(t.innerText || t.getAttribute?.('aria-label') || '');
        if (/^(yes|no|y|n)$/i.test(text) || t.closest?.('[class*="question"], fieldset, form')) {
          schedule(t);
        }
      }
    };

    document.addEventListener('change', onInputish, { capture: true, signal: ac.signal });
    document.addEventListener('input', onInputish, { capture: true, signal: ac.signal });
    document.addEventListener('click', onInputish, { capture: true, signal: ac.signal });
  };

  // ─── Work / education history ───────────────────────────────
  // Filled from the parsed resume only — never from (or into) fixed answers.

  const WORK_HEADING_RE =
    /^((work|employment|professional|job)\s+(history|experiences?)|experiences?|(previous|past)\s+(employment|employers?|jobs?))(\s*\d+)?$/i;
  const EDU_HEADING_RE =
    /^(education(al)?(\s+(history|background|details))?|academic\s+(history|background)|schools?(\s+attended)?)(\s*\d+)?$/i;
  const ADD_ENTRY_RE =
    /^(\+\s*)?add(\s+(another|more|new|a))?(\s+(work\s+)?(experience|employment|job|position|education|school|degree))?\s*\+?$/i;
  const HISTORY_MAX = { work: 6, education: 4 };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function historyHeadingKind(text) {
    const t = normalizeLabel(text).replace(/[:*]+$/, '').trim();
    if (!t || t.length > 40) return null;
    if (WORK_HEADING_RE.test(t)) return 'work';
    if (EDU_HEADING_RE.test(t)) return 'education';
    return null;
  }

  /** Everything that names a control: label, aria, name/id, placeholder, Workday formField id. */
  function historyDescriptor(el) {
    const bits = [
      labelFor(el),
      el.getAttribute('aria-label'),
      el.getAttribute('name'),
      el.id,
      el.getAttribute('placeholder'),
    ];
    const ff = el.closest('[data-automation-id^="formField-"]');
    if (ff) {
      bits.push(
        ff
          .getAttribute('data-automation-id')
          .replace(/^formField-/, '')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
      );
    }
    return bits
      .filter(Boolean)
      .join(' | ')
      .replace(/[_\[\]-]+/g, ' ')
      .toLowerCase();
  }

  /**
   * Which history slot a control is. Education-specific fields (school, degree, major, GPA)
   * are recognized anywhere; generic ones (title, location, dates) only inside a
   * Work/Education section, so e.g. "Available start date" is never treated as history.
   */
  function classifyHistoryField(el, d, context) {
    const type = (el.type || '').toLowerCase();
    const part = /\bmonth\b|\bmm\b/.test(d) ? 'month' : /\byears?\b|\byyyy\b/.test(d) ? 'year' : 'date';
    const short = normalizeLabel(labelFor(el)).length <= 60;

    if (short && /\b(school|university|college|institution)\b/.test(d)) return { section: 'education', kind: 'school' };
    if (short && /\bdegree\b/.test(d) && type !== 'checkbox') return { section: 'education', kind: 'degree' };
    if (short && /discipline|\bmajor\b|field\s*of\s*study|area\s*of\s*study|specialization|concentration/.test(d)) {
      return { section: 'education', kind: 'field' };
    }
    if (short && /\bgpa\b|grade\s*(point\s*)?average/.test(d)) return { section: 'education', kind: 'gpa' };
    if (/first\s*year\s*attended/.test(d)) return { section: 'education', kind: 'start', part: 'year' };
    if (/last\s*year\s*attended/.test(d)) return { section: 'education', kind: 'end', part: 'year' };

    if (!context) return null;
    if (context === 'work') {
      if (type === 'checkbox') {
        return /currently\s+work|current(ly)?\s+(employ|job|role|position)|work\s+here|\bpresent\b/.test(d)
          ? { section: 'work', kind: 'current' }
          : null;
      }
      if (/\b(company|employer|organi[sz]ation)\b/.test(d)) return { section: 'work', kind: 'company' };
      if (/description|responsibilit|duties|achievements|summary/.test(d)) return { section: 'work', kind: 'description' };
      if (/job\s*title|\btitle\b|\bposition\b|\brole\b/.test(d)) return { section: 'work', kind: 'title' };
      if (/\blocation\b|\bcity\b/.test(d)) return { section: 'work', kind: 'location' };
    }
    if (type === 'checkbox') return null;
    if (/\b(start|from|begin|began|first)\b/.test(d)) return { section: context, kind: 'start', part };
    if (/\b(end|to|until|finish|graduat\w*|completion|last)\b/.test(d)) return { section: context, kind: 'end', part };
    return null;
  }

  /**
   * Walk the page in document order: section headings set the context, controls are grouped into
   * entries (a repeated slot or a numbered heading like "Work Experience 2" starts a new entry).
   */
  function scanHistory() {
    const out = {
      work: { entries: [], addButtons: [] },
      education: { entries: [], addButtons: [] },
    };
    let context = null;
    const startEntry = (section) => {
      const list = out[section].entries;
      if (!list.length || list[list.length - 1].fields.length) list.push({ fields: [], slots: new Set() });
    };
    const nodes = document.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, legend, [role="heading"], [class*="heading" i], [class*="section-title" i], [data-automation-id*="Header"], ' +
        'button, [role="button"], a, input, select, textarea, [role="combobox"]'
    );
    for (const node of nodes) {
      if (node.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) continue;
      const tag = node.tagName;
      const isControl = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || node.getAttribute('role') === 'combobox';

      if (!isControl) {
        const text = normalizeLabel(node.innerText || node.textContent || '');
        if (/^(BUTTON|A)$/.test(tag) || node.getAttribute('role') === 'button') {
          const label = text || node.getAttribute('aria-label') || '';
          if (context && ADD_ENTRY_RE.test(label.trim()) && isVisible(node)) out[context].addButtons.push(node);
          continue;
        }
        const kind = historyHeadingKind(text);
        const realHeading = /^(H[1-6]|LEGEND)$/.test(tag) || node.getAttribute('role') === 'heading';
        if (kind) {
          context = kind;
          // "Work Experience 2" — explicit entry boundary
          if (/\d+\s*$/.test(text)) startEntry(kind);
        } else if (realHeading && text.length >= 2 && text.length <= 80 && !historyHeadingKind(text)) {
          context = null;
        }
        continue;
      }

      const type = (node.type || '').toLowerCase();
      if (SKIP_TYPES.has(type) || type === 'radio') continue;
      if (node.getAttribute('role') === 'combobox' && node.tagName !== 'INPUT' && node.querySelector('input')) continue;
      if (!isFieldCollectible(node)) continue;
      const slot = classifyHistoryField(node, historyDescriptor(node), context);
      if (!slot) continue;
      const section = out[slot.section];
      const slotKey = `${slot.kind}:${slot.part || ''}`;
      let entry = section.entries[section.entries.length - 1];
      if (!entry || entry.slots.has(slotKey)) {
        section.entries.push({ fields: [], slots: new Set() });
        entry = section.entries[section.entries.length - 1];
      }
      entry.slots.add(slotKey);
      entry.fields.push({ el: node, kind: slot.kind, part: slot.part || null });
    }
    for (const s of Object.values(out)) s.entries = s.entries.filter((e) => e.fields.length);
    return out;
  }

  let historyCache = { at: 0, set: new WeakSet() };
  function historyFieldSet() {
    if (Date.now() - historyCache.at > 1500) {
      const set = new WeakSet();
      try {
        const scan = scanHistory();
        for (const s of Object.values(scan)) for (const e of s.entries) for (const f of e.fields) set.add(f.el);
      } catch {
        /* ignore */
      }
      historyCache = { at: Date.now(), set };
    }
    return historyCache.set;
  }

  /** True for controls owned by a Work/Education history entry (excluded from Q&A + learning). */
  function isHistoryField(el) {
    return !!el && historyFieldSet().has(el);
  }
  HS.isHistoryField = isHistoryField;

  /** The page has Work/Education entries (or an "Add" button to create them). */
  HS.hasHistorySections = function hasHistorySections() {
    const scan = scanHistory();
    return Object.values(scan).some((s) => s.entries.length || s.addButtons.length);
  };

  const pad2 = (n) => String(n).padStart(2, '0');

  /** Value(s) for one slot; arrays are tried in order (e.g. degree level, then degree as written). */
  function historySlotValue(section, entry, field) {
    const { el, kind, part } = field;
    switch (kind) {
      case 'title':
      case 'company':
      case 'location':
      case 'description':
      case 'school':
      case 'field':
      case 'gpa':
        return entry[kind] || '';
      case 'degree':
        return [entry.degreeLevel, entry.degree].filter(Boolean);
      case 'current':
        return entry.current ? 'Yes' : 'No';
      default:
        break;
    }
    if (kind !== 'start' && kind !== 'end') return '';
    if (kind === 'end' && entry.current) return '';
    const y = kind === 'start' ? entry.startYear : entry.endYear;
    const m = section === 'work' ? (kind === 'start' ? entry.startMonth : entry.endMonth) : null;
    if (part === 'year') return y ? String(y) : '';
    if (part === 'month') {
      if (!m) return '';
      return el.tagName === 'SELECT' || isComboboxLike(el) ? [MONTHS[m - 1], pad2(m), String(m)] : pad2(m);
    }
    if (!y) return '';
    const type = (el.type || '').toLowerCase();
    const mm = pad2(m || 1);
    if (type === 'month') return `${y}-${mm}`;
    if (type === 'date') return `${y}-${mm}-01`;
    const ph = String(el.getAttribute('placeholder') || '').toLowerCase();
    if (/mm\s*\/\s*dd\s*\/\s*yyyy/.test(ph)) return `${mm}/01/${y}`;
    if (/yyyy\s*-\s*mm/.test(ph)) return `${y}-${mm}`;
    if (/mm\s*\/\s*yy(?!yy)/.test(ph)) return `${mm}/${String(y).slice(2)}`;
    if (/^\s*yyyy\s*$/.test(ph) || !m) return String(y);
    return `${mm}/${y}`;
  }

  async function setHistoryControl(el, value, label) {
    const candidates = (Array.isArray(value) ? value : [value]).map((v) => String(v || '').trim()).filter(Boolean);
    if (!candidates.length) return false;
    if ((el.type || '').toLowerCase() === 'checkbox') return fillCheckbox(el, candidates[0]);
    for (const v of candidates) {
      let ok = false;
      if (el.tagName === 'SELECT') ok = fillSelect(el, v, label);
      else if (isComboboxLike(el) || el.getAttribute('role') === 'combobox') ok = await fillCombobox(el, v, label);
      else ok = await commitTextField(el, v);
      if (ok) return true;
    }
    return false;
  }

  /**
   * Fill Work/Employment history and Education from the parsed resume.
   * history: { work: [...], education: [...] } (most recent first). Adds entries via the
   * section's "Add" button when the resume has more than the form shows. Never overwrites
   * a value already on the page (e.g. from the site's own resume parser).
   */
  HS.fillHistory = async function fillHistory(history, { shouldCancel } = {}) {
    const result = { filled: 0, entries: [] };
    for (const section of ['work', 'education']) {
      const data = (history?.[section] || []).slice(0, HISTORY_MAX[section]);
      if (!data.length) continue;
      let scan = scanHistory()[section];

      // Grow the form until it has one entry per resume item
      for (let guard = 0; scan.entries.length < data.length && guard < HISTORY_MAX[section]; guard++) {
        const btn = scan.addButtons[scan.addButtons.length - 1];
        if (!btn || shouldCancel?.()) break;
        clickOnce(btn);
        await sleep(600);
        const next = scanHistory()[section];
        if (next.entries.length <= scan.entries.length) break;
        scan = next;
      }

      const n = Math.min(scan.entries.length, data.length);
      for (let i = 0; i < n; i++) {
        if (shouldCancel?.()) return result;
        const entry = data[i];
        let filledHere = 0;
        // Tick "I currently work here" first: it usually hides the end-date fields
        const fields = scan.entries[i].fields
          .slice()
          .sort((a, b) => (a.kind === 'current' ? -1 : 0) - (b.kind === 'current' ? -1 : 0));
        for (const f of fields) {
          if (!document.contains(f.el)) continue;
          if (f.kind !== 'current' && fieldValue(f.el)) continue;
          const value = historySlotValue(section, entry, f);
          if (!value || (Array.isArray(value) && !value.length)) continue;
          if (f.kind === 'current' && !entry.current) continue;
          const ok = await setHistoryControl(f.el, value, labelFor(f.el));
          if (ok) {
            filledHere += 1;
            f.el.classList?.add('hs-filled');
          }
        }
        result.filled += filledHere;
        result.entries.push({
          section,
          index: i,
          label:
            section === 'work'
              ? [entry.title, entry.company].filter(Boolean).join(' · ')
              : [entry.degree || entry.degreeLevel, entry.school].filter(Boolean).join(' · '),
          filled: filledHere > 0,
        });
      }
    }
    historyCache.at = 0;
    return result;
  };

  HS.findResumeInputs = function findResumeInputs() {
    return Array.from(document.querySelectorAll('input[type="file"]')).filter((el) => {
      if (el.disabled || el.readOnly) return false;
      if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return false;
      const accept = (el.accept || '').toLowerCase();
      const name = `${el.name || ''} ${el.id || ''} ${labelFor(el)}`.toLowerCase();
      const near = normalizeLabel(el.closest('section, form, div, label')?.innerText || '').slice(
        0,
        240
      );
      return (
        /pdf|doc|msword|officedocument/.test(accept) ||
        /resume|cv|curriculum|attach|upload/.test(name) ||
        /autofill from resume|upload your resume|upload file/i.test(near) ||
        (!accept && /file|document|attachment/.test(name))
      );
    });
  };

  function attachFileToInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.classList.add('hs-filled');
  }

  /** Attach a File to resume/CV file inputs on the page. */
  HS.fillResumeInputs = function fillResumeInputs(file) {
    if (!file) return 0;
    const inputs = HS.findResumeInputs();
    let filled = 0;
    for (const input of inputs) {
      try {
        attachFileToInput(input, file);
        filled += 1;
      } catch (err) {
        console.warn('Could not fill resume input', err);
      }
    }
    return filled;
  };

  function hostAutofillRootText(el) {
    return normalizeLabel(el?.innerText || el?.textContent || '');
  }

  /** Success copy for the resume widget only (ignore other page autofill tools). */
  const HOST_RESUME_COMPLETE_RE =
    /autofill\s+completed|autofill\s+complete[!.,]?|please review the information we filled|review the information we filled|successfully\s+autofilled|resume\s+autofill\s+(is\s+)?complete/i;

  const HOST_RESUME_TITLE_RE = /autofill from resume|autofill\s+from\s+your\s+resume|resume\s+autofill/i;

  function looksLikeHostResumeAutofillRoot(el) {
    if (!el || !document.contains(el)) return false;
    if (!isVisible(el)) return false;
    if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return false;
    const t = hostAutofillRootText(el);
    if (!t || t.length < 20 || t.length > 1200) return false;
    // Strict: must be the "Autofill from resume" card — not generic Autofill
    if (!HOST_RESUME_TITLE_RE.test(t)) return false;
    const hasUploadCue =
      /upload (your )?resume|upload file|upload your resume here to autofill/i.test(t) ||
      !!el.querySelector('input[type="file"]');
    const hasCompleteCue = HOST_RESUME_COMPLETE_RE.test(t);
    return hasUploadCue || hasCompleteCue;
  }

  /** Only true when the Autofill-from-resume card (or its nearby banner) finished. */
  function isHostResumeAutofillComplete(root) {
    if (!root || !document.contains(root)) return false;

    const checkNode = (node) => {
      if (!node) return false;
      const t = hostAutofillRootText(node);
      if (!t || t.length > 4000) return false;
      // Require resume-autofill context in the same subtree so other autofills are ignored
      if (!HOST_RESUME_TITLE_RE.test(t) && !looksLikeHostResumeAutofillRoot(root)) return false;
      return HOST_RESUME_COMPLETE_RE.test(t);
    };

    if (checkNode(root)) return true;

    // Success banner is often a sibling under a shared parent of the resume card
    let node = root.parentElement;
    for (let i = 0; i < 4 && node; i++) {
      if (checkNode(node)) return true;
      // Also check direct children for a completed banner next to the upload card
      for (const child of Array.from(node.children || [])) {
        if (child === root) continue;
        const ct = hostAutofillRootText(child);
        if (
          ct &&
          ct.length < 800 &&
          HOST_RESUME_COMPLETE_RE.test(ct) &&
          (HOST_RESUME_TITLE_RE.test(hostAutofillRootText(node)) ||
            HOST_RESUME_TITLE_RE.test(ct) ||
            looksLikeHostResumeAutofillRoot(root))
        ) {
          return true;
        }
      }
      node = node.parentElement;
    }
    return false;
  }

  function countFilledBasicsNear(root) {
    const scope =
      (root && document.contains(root) && root.closest('form, main, [role="main"]')) ||
      document;
    const fields = Array.from(scope.querySelectorAll('input, textarea, select')).filter((el) => {
      if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return false;
      if (!isVisible(el) && el.type !== 'hidden') return false;
      const type = (el.type || '').toLowerCase();
      if (SKIP_TYPES.has(type)) return false;
      return !!fieldValue(el);
    });
    return fields.length;
  }

  function countContactFieldsFilled() {
    let n = 0;
    document.querySelectorAll('input, textarea').forEach((el) => {
      if (el.closest('#hs-panel, #hs-dock, #hs-info-dialog, #hs-job-dialog')) return;
      if (!isVisible(el)) return;
      const type = (el.type || '').toLowerCase();
      if (SKIP_TYPES.has(type)) return;
      const label = `${labelFor(el)} ${el.name || ''} ${el.id || ''} ${el.autocomplete || ''}`.toLowerCase();
      const val = fieldValue(el);
      if (!val) return;
      if (
        type === 'email' ||
        type === 'tel' ||
        /e-?mail|phone|mobile|name|linkedin|first|last/.test(label) ||
        /@/.test(val)
      ) {
        n += 1;
      }
    });
    return n;
  }

  /**
   * Detect third-party "Autofill from resume" widgets (e.g. ATS helpers).
   * Returns null when none found.
   */
  HS.detectHostResumeAutofill = function detectHostResumeAutofill() {
    const nodes = Array.from(
      document.querySelectorAll('section, article, aside, form, div, [class], [data-testid]')
    );
    let best = null;
    let bestLen = Infinity;
    for (const el of nodes) {
      if (!looksLikeHostResumeAutofillRoot(el)) continue;
      const len = hostAutofillRootText(el).length;
      // Prefer the smallest matching container (the card, not the page)
      if (len < bestLen) {
        best = el;
        bestLen = len;
      }
    }
    if (!best) {
      // Do not treat other page autofill tools as "Autofill from resume"
      return null;
    }

    const fileInput =
      best.querySelector('input[type="file"]') ||
      best.parentElement?.querySelector?.('input[type="file"]') ||
      null;

    return {
      root: best,
      fileInput,
      kind: 'resume',
      isComplete: () => isHostResumeAutofillComplete(best),
      filledBasics: () => countFilledBasicsNear(best),
    };
  };

  /** Attach resume specifically into a detected host autofill widget. */
  HS.feedHostResumeAutofill = function feedHostResumeAutofill(host, file) {
    if (!host || !file) return 0;
    let filled = 0;
    const inputs = [];
    if (host.fileInput && document.contains(host.fileInput)) inputs.push(host.fileInput);
    if (host.root && document.contains(host.root)) {
      host.root.querySelectorAll?.('input[type="file"]').forEach((el) => inputs.push(el));
    }
    const unique = [...new Set(inputs)];
    for (const input of unique) {
      try {
        attachFileToInput(input, file);
        filled += 1;
      } catch (err) {
        console.warn('Could not feed host resume autofill', err);
      }
    }
    return filled;
  };

  /**
   * Wait until host "Autofill from resume" finishes — ignore other autofill tools.
   * Completes only when that resume widget reports success (or timeout).
   */
  HS.waitForHostResumeAutofill = function waitForHostResumeAutofill(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 45000;
    const pollMs = opts.pollMs ?? 350;
    const shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : () => false;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const initialRoot = opts.hostRoot || null;

    return new Promise((resolve) => {
      const started = Date.now();

      const finish = (result) => {
        clearInterval(timer);
        resolve(result);
      };

      const tick = () => {
        if (shouldCancel()) {
          finish({ complete: false, timedOut: false, cancelled: true, filledBasics: 0 });
          return;
        }

        // Always re-detect the resume widget — React often replaces the card after success
        const host = HS.detectHostResumeAutofill();
        const root = host?.root || (initialRoot && document.contains(initialRoot) ? initialRoot : null);
        const complete = root ? isHostResumeAutofillComplete(root) : false;
        const filledBasics = root ? countFilledBasicsNear(root) : 0;
        const elapsed = Date.now() - started;
        onProgress?.({ elapsed, complete, filledBasics, host });

        // Only the Autofill-from-resume widget completion counts — not other autofills
        if (complete) {
          finish({ complete: true, timedOut: false, cancelled: false, filledBasics });
          return;
        }

        if (elapsed >= timeoutMs) {
          finish({ complete: false, timedOut: true, cancelled: false, filledBasics });
        }
      };

      const timer = setInterval(tick, pollMs);
      tick();
    });
  };

  /** Cover letters are left for the user — never autofill. */
  HS.isCoverLetterField = function isCoverLetterField(question, fieldMeta = {}) {
    const q = normalizeLabel(question || '').toLowerCase();
    const ph = String(fieldMeta.placeholder || '').toLowerCase();
    const name = String(fieldMeta.name || fieldMeta.id || '').toLowerCase();
    return (
      /cover\s*letter/.test(q) ||
      /cover\s*letter/.test(ph) ||
      /cover.?letter|coverletter/.test(name)
    );
  };
})();
