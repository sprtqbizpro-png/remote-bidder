/**
 * Hybrid job extraction:
 * 1) JSON-LD JobPosting
 * 2) Known ATS CSS extractors
 * 3) Heuristic main/article scrape + confidence score
 * 4) Caller may fall back to OpenAI via getPageTextForLlm()
 */
(function () {
  const HS = (window.HiddenStar = window.HiddenStar || {});

  const CONFIDENCE_OK = 0.72;

  const NOISE_LINE =
    /^(back to jobs?|back|apply( now)?|apply for this job|easy apply|save job|share|new|featured|remote|hybrid|on-?site|full[- ]?time|part[- ]?time|contract|internship|posted( on)?.*|viewed|report( this)?( job)?|show more|show less|see more|read more|cookie|accept all|sign in|log in|follow|employees? on linkedin)$/i;

  /** Section labels that must never be treated as the job title. */
  const SECTION_HEADER_ROLE =
    /^(job\s*description|description|job\s*details?|overview|about\s+(the\s+)?(role|job|us|company)|responsibilit(y|ies)|requirement(s)?|qualification(s)?|basic\s+search|printable\s+format|apply\s+online|work\s+model|benefits|what\s+you.?ll\s+do|about\s+this\s+role)$/i;

  function isBadRoleTitle(t) {
    const s = String(t || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s || s.length < 3) return true;
    if (SECTION_HEADER_ROLE.test(s)) return true;
    if (NOISE_LINE.test(s)) return true;
    if (/^(yes|no|optional|required)$/i.test(s)) return true;
    return false;
  }

  function titleCaseBrand(slug) {
    const known = {
      cognizant: 'Cognizant',
      accenture: 'Accenture',
      deloitte: 'Deloitte',
      infosys: 'Infosys',
      wipro: 'Wipro',
      ibm: 'IBM',
      oracle: 'Oracle',
      microsoft: 'Microsoft',
      amazon: 'Amazon',
      google: 'Google',
    };
    const key = String(slug || '')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '');
    if (known[key]) return known[key];
    return String(slug || '')
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  /** e.g. cognizant.taleo.net → Cognizant */
  function companyFromHost() {
    const host = location.hostname.replace(/^www\./, '').toLowerCase();
    const taleo = host.match(/^([a-z0-9-]+)\.taleo\.net$/i);
    if (taleo) return titleCaseBrand(taleo[1]);
    const myworkday = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i);
    if (myworkday) return titleCaseBrand(myworkday[1]);
    if (/greenhouse|lever\.co|ashbyhq|linkedin|indeed|myworkdayjobs|taleo\.net/i.test(host)) {
      return '';
    }
    const base = host.split('.')[0];
    if (base && base.length > 1 && !/^(jobs|careers|www|app|board)$/i.test(base)) {
      return titleCaseBrand(base);
    }
    return '';
  }

  function companyFromLogo() {
    const imgs = document.querySelectorAll(
      'img[alt], img[title], a.logo img, .logo img, header img, #header img'
    );
    for (const img of imgs) {
      const alt = (img.getAttribute('alt') || img.getAttribute('title') || '').trim();
      if (!alt || alt.length < 2 || alt.length > 60) continue;
      if (/logo|brand|home|icon/i.test(alt) && alt.length < 8) continue;
      const cleaned = alt.replace(/\s*logo\s*/i, ' ').trim();
      if (cleaned && !isBadRoleTitle(cleaned) && cleaned.length < 40) return cleaned;
    }
    return '';
  }

  /** UI chrome that must never end up inside a description (subset of NOISE_LINE: no job-meta chips). */
  const UI_NOISE_LINE =
    /^(back to jobs?|back|apply( now)?|apply for this job|easy apply|save( job)?|share( this job)?|new|featured|report( this)?( job)?|show more|show less|see more|read more|cookie|accept all|sign in|log in|follow|employees? on linkedin)$/i;
  const LEAF_BADGE = /^(apply|new|hot|urgent|hiring|remote only)$/i;

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'img', 'picture', 'video', 'audio', 'canvas',
    'iframe', 'object', 'nav', 'header', 'footer', 'button', 'input', 'select', 'textarea', 'label',
    'dialog',
  ]);
  const SKIP_ROLES = /^(button|navigation|banner|contentinfo|dialog|alertdialog|tooltip|menu|menubar|search)$/i;
  const HIDDEN_CLASS_RE = /(^|\s)(sr-only|visually-hidden|visuallyhidden|screen-reader-text|screenreader|a11y-hidden|assistive-text)(\s|$)/i;
  const NOISE_CLASS_TOKENS = new Set([
    'cookie', 'cookies', 'breadcrumb', 'breadcrumbs', 'share', 'social', 'related', 'similar',
    'recommended', 'recommendations', 'tooltip', 'modal', 'toast',
  ]);
  /** Used when there is no layout (DOMParser documents, e.g. JSON-LD HTML). */
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'dd', 'details', 'div', 'dl',
    'dt', 'fieldset', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'main',
    'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  ]);
  const PARAGRAPH_TAGS = new Set(['p', 'blockquote', 'pre', 'table', 'dl', 'figure']);

  function textOf(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function firstMatch(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) {
          const t = textOf(el);
          if (t) return t;
        }
      } catch {
        /* ignore */
      }
    }
    return '';
  }

  function metaContent(nameOrProp) {
    const el =
      document.querySelector(`meta[property="${nameOrProp}"]`) ||
      document.querySelector(`meta[name="${nameOrProp}"]`);
    return el?.content?.trim() || '';
  }

  function detectAts() {
    const host = location.hostname.toLowerCase();
    const href = location.href.toLowerCase();
    if (host.includes('taleo.net') || href.includes('taleo') || href.includes('careersection')) {
      return 'taleo';
    }
    if (document.querySelector('#requisitionDescriptionInterface, .editablesection, .contentlinepanel')) {
      if (host.includes('taleo') || document.querySelector('[id*="requisitionDescriptionInterface"]')) {
        return 'taleo';
      }
    }
    if (host.includes('greenhouse') || href.includes('greenhouse')) return 'greenhouse';
    if (host.includes('lever.co') || href.includes('jobs.lever.co')) return 'lever';
    if (host.includes('ashbyhq') || href.includes('ashby')) return 'ashby';
    if (host.includes('myworkdayjobs') || host.includes('workday')) return 'workday';
    if (host.includes('linkedin')) return 'linkedin';
    if (host.includes('indeed')) return 'indeed';
    if (document.querySelector('.ashby-job-posting-heading, [class*="ashby"]')) return 'ashby';
    if (document.querySelector('#content .app-title, #application_form')) return 'greenhouse';
    if (document.querySelector('.posting-headline, .postings-wrapper')) return 'lever';
    return 'generic';
  }

  // ─── JSON-LD ───────────────────────────────────────────────
  function extractJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        let data = JSON.parse(script.textContent || '');
        const items = Array.isArray(data) ? data : [data];
        const queue = [];
        for (const item of items) {
          if (!item) continue;
          queue.push(item);
          if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
        }
        for (const item of queue) {
          const type = item['@type'];
          const types = Array.isArray(type) ? type : [type];
          if (!types.some((t) => String(t).toLowerCase() === 'jobposting')) continue;

          const company =
            item.hiringOrganization?.name ||
            item.hiringOrganization?.legalName ||
            (typeof item.hiringOrganization === 'string' ? item.hiringOrganization : '') ||
            '';

          let description = decodeEntities(item.description || '');
          if (description && /<[a-z][^>]*>/i.test(description)) {
            description = htmlToStructured(description);
          } else {
            description = cleanStructuredText(String(description));
          }

          const role = item.title || '';
          if (!role && !description) continue;

          return {
            companyName: String(company).trim(),
            roleName: String(role).trim(),
            jobDescription: description,
            location:
              item.jobLocation?.address?.addressLocality ||
              item.jobLocation?.name ||
              null,
            source: 'json-ld',
            ats: detectAts(),
            confidence: scoreResult({
              companyName: company,
              roleName: role,
              jobDescription: description,
              source: 'json-ld',
            }),
          };
        }
      } catch {
        /* ignore bad json */
      }
    }
    return null;
  }

  // ─── Taleo (Oracle) ────────────────────────────────────────
  function cleanTaleoTitle(t) {
    return String(t || '')
      .replace(/\s+/g, ' ')
      .replace(/\s*\(\s*Job\s*Number\s*:\s*/i, ' (Job Number: ')
      .trim();
  }

  function extractTaleoRole() {
    const selectors = [
      '[id*="reqTitle"]',
      '[id*="ReqTitle"]',
      '.titlepage',
      'span.title',
      'td.titlepage',
      'div.titlepage',
      'h1',
      'h2',
    ];
    for (const sel of selectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          const t = cleanTaleoTitle(textOf(el));
          if (isBadRoleTitle(t)) continue;
          if (t.length < 8 || t.length > 220) continue;
          // Prefer titles that include a job number (Taleo classic)
          if (/job\s*number\s*:/i.test(t) || /\(\s*\d{6,}\s*\)/.test(t)) return t;
        }
      } catch {
        /* ignore */
      }
    }

    // Scan leaf-ish nodes for "Job Number" / requisition id titles
    const nodes = document.querySelectorAll('span, td, div, h1, h2, h3, b, strong');
    let best = '';
    let bestScore = 0;
    for (const el of nodes) {
      if (el.querySelector?.('span, div, td, p, li') && textOf(el).length > 240) continue;
      const t = cleanTaleoTitle(textOf(el));
      if (isBadRoleTitle(t) || t.length < 10 || t.length > 220) continue;
      let s = 0;
      if (/job\s*number\s*:/i.test(t)) s += 80;
      if (/\(\s*\d{6,}\s*\)/.test(t)) s += 40;
      if (/\b(senior|lead|engineer|developer|manager|analyst|architect|director)\b/i.test(t)) s += 20;
      if (el.tagName === 'H1' || el.tagName === 'H2') s += 15;
      if (/titlepage|title|jobtitle|reqtitle/i.test(`${el.className || ''} ${el.id || ''}`)) s += 25;
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
    }
    if (bestScore >= 40 && best) return best;

    // After a "Job Description" label, the next substantial line is usually the title
    const allText = document.body?.innerText || '';
    const m = allText.match(
      /Job\s*Description\s*\r?\n+\s*([^\r\n]{10,200})/i
    );
    if (m && !isBadRoleTitle(m[1])) return cleanTaleoTitle(m[1]);

    return '';
  }

  function extractTaleoDescription() {
    const selectors = [
      '[id*="requisitionDescriptionInterface"][id*="description"]',
      '[id*="DescriptionText"]',
      '[id*="descriptionText"]',
      '.editablesection',
      '.contentlinepanel',
      '#jobdesc',
      '.jobdescription',
      'span.jobdescription',
      '[class*="jobdescription"]',
      '[class*="JobDescription"]',
    ];

    let best = '';
    let bestScore = 0;
    for (const sel of selectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          const t = serializeElement(el);
          const s = scoreDescription(t);
          if (s > bestScore) {
            bestScore = s;
            best = t;
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (bestScore >= 80) return best;

    // Fallback: body text from "Description" / "About the role" onward
    const raw = document.body?.innerText || '';
    const start = raw.search(
      /\n\s*(Description|About the role|In this role, you will)\s*\n/i
    );
    if (start >= 0) {
      let chunk = raw.slice(start).trim();
      chunk = chunk.replace(/^(Description)\s*/i, '').trim();
      const cut = chunk.search(
        /\n\s*(Basic Search|Return to the home page|My Jobpage|Apply Online)\s*$/im
      );
      if (cut > 200) chunk = chunk.slice(0, cut);
      const cleaned = cleanPlainText(chunk).slice(0, 18000);
      if (scoreDescription(cleaned) >= 80) return cleaned;
    }

    return best;
  }

  function extractTaleo() {
    const roleName = extractTaleoRole();
    const companyName =
      companyFromLogo() || companyFromHost() || firstMatch(['.company-name', '#header .companyname']);
    const jobDescription = extractTaleoDescription();

    if (!roleName && !jobDescription) return null;

    const result = {
      companyName: companyName || companyFromHost(),
      roleName,
      jobDescription,
      location: null,
      source: 'ats:taleo',
      ats: 'taleo',
    };
    result.confidence = scoreResult(result);
    return result;
  }

  // ─── ATS-specific ──────────────────────────────────────────
  function extractByAts(ats) {
    if (ats === 'taleo') return extractTaleo();

    const maps = {
      greenhouse: {
        role: ['h1.app-title', 'h1', '.app-title'],
        company: ['.company-name', '#header .company-name', '[data-company-name]'],
        desc: ['#content .section-wrapper', '#content', '.content', '#job_description'],
      },
      lever: {
        role: ['.posting-headline h2', 'h2', 'h1'],
        company: ['.main-header-logo img[alt]', '.posting-headline .company', '.company-name'],
        desc: ['.posting .content', '.section-wrapper', '.posting-page .content'],
      },
      ashby: {
        role: ['.ashby-job-posting-heading h1', 'h1'],
        company: ['.ashby-job-posting-company-name', '[class*="company"]'],
        desc: ['.ashby-job-posting-section', '[class*="job-posting"]'],
      },
      indeed: {
        role: ['.jobsearch-JobInfoHeader-title', 'h1'],
        company: ['.jobsearch-InlineCompanyRating a', '[data-company-name]', '.jobsearch-CompanyInfoContainer a'],
        desc: ['#jobDescriptionText', '.jobsearch-jobDescriptionText'],
      },
      linkedin: {
        role: ['.job-details-jobs-unified-top-card__job-title', 'h1'],
        company: ['.job-details-jobs-unified-top-card__company-name a', '.topcard__org-name-link'],
        desc: ['#job-details', '.jobs-description__content', '.jobs-box__html-content'],
      },
      workday: {
        role: ['h2[data-automation-id="jobPostingHeader"]', 'h1'],
        company: ['[data-automation-id="company"]', '[data-automation-id="jobPostingCompanyName"]'],
        desc: ['[data-automation-id="jobPostingDescription"]'],
      },
    };

    const cfg = maps[ats];
    if (!cfg) return null;

    let roleName = firstMatch(cfg.role);
    if (isBadRoleTitle(roleName)) {
      // Try remaining role selectors until a real title is found
      roleName = '';
      for (const sel of cfg.role) {
        try {
          for (const el of document.querySelectorAll(sel)) {
            const t = textOf(el);
            if (!isBadRoleTitle(t) && t.length >= 5) {
              roleName = t;
              break;
            }
          }
        } catch {
          /* ignore */
        }
        if (roleName) break;
      }
    }
    // Lever logo alt often holds company
    if (ats === 'lever' && !firstMatch(cfg.company)) {
      const img = document.querySelector('.main-header-logo img[alt]');
      if (img?.alt) cfg._companyFromAlt = img.alt.trim();
    }
    let companyName =
      firstMatch(cfg.company) || cfg._companyFromAlt || companyFromLogo() || companyFromHost();

    let jobDescription = '';
    if (ats === 'ashby') {
      const sections = document.querySelectorAll(cfg.desc.join(','));
      const parts = [];
      sections.forEach((el) => {
        const t = serializeElement(el);
        if (t && scoreDescription(t) >= 30) parts.push(t);
      });
      jobDescription = cleanStructuredText(parts.join('\n\n'));
    } else {
      for (const sel of cfg.desc) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const t = serializeElement(el);
        if (scoreDescription(t) >= 80) {
          jobDescription = t;
          break;
        }
      }
    }

    if (!roleName && !jobDescription) return null;

    const result = {
      companyName,
      roleName,
      jobDescription,
      location: null,
      source: `ats:${ats}`,
      ats,
    };
    result.confidence = scoreResult(result);
    return result;
  }

  // ─── Generic heuristics ─────────────────────────────────────
  function extractRoleGeneric() {
    const selectors = [
      'h1[data-testid="job-title"]',
      'h1.job-title',
      'h1.posting-headline',
      '.jobsearch-JobInfoHeader-title',
      '[data-automation-id="jobPostingHeader"]',
      '.job__title h1',
      '.posting-headline h2',
      'h1.app-title',
      '[data-testid="job-detail-title"]',
      '.ashby-job-posting-heading h1',
      '.titlepage',
      'h1',
      'h2',
    ];
    for (const sel of selectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          const t = textOf(el);
          if (!isBadRoleTitle(t) && t.length >= 5 && t.length < 220) return t;
        }
      } catch {
        /* ignore */
      }
    }
    const og = metaContent('og:title');
    if (og && !isBadRoleTitle(og.split(/[|\-–—]/)[0].trim())) {
      return og.split(/[|\-–—]/)[0].trim();
    }
    const docTitle = document.title.split(/[|\-–—]/)[0].trim();
    if (!isBadRoleTitle(docTitle)) return docTitle;
    return '';
  }

  function extractCompanyGeneric() {
    const fromDom = firstMatch([
      '[data-testid="company-name"]',
      '.jobsearch-InlineCompanyRating a',
      '.company-name',
      '[data-company-name]',
      '.app-title + .company',
      '.posting-headline .company-name',
      '[data-automation-id="company"]',
      'a[data-testid="jobDetailCompanyLink"]',
      '.employer-name',
      '.topcard__org-name-link',
      '.ashby-job-posting-company-name',
    ]);
    // Reject if DOM "company" is actually the job title / section header
    if (fromDom && !isBadRoleTitle(fromDom) && fromDom.length < 80 && !/job\s*number/i.test(fromDom)) {
      return fromDom;
    }

    const companyAttr = document.querySelector('[data-company-name]');
    if (companyAttr) {
      const v = companyAttr.getAttribute('data-company-name');
      if (v && !isBadRoleTitle(v)) return v;
    }

    const fromLogo = companyFromLogo();
    if (fromLogo) return fromLogo;

    const fromHost = companyFromHost();
    if (fromHost) return fromHost;

    const og = metaContent('og:site_name');
    if (og && !/linkedin|indeed|greenhouse|lever|workday|ashby|taleo/i.test(og)) return og;

    const title = document.title;
    const at = title.match(/\bat\s+([^|\-–—]+)/i);
    if (at && !isBadRoleTitle(at[1].trim()) && at[1].trim().length < 60) return at[1].trim();
    const parts = title.split(/[|\-–—]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      if (!isBadRoleTitle(last) && last.length < 60 && !/job\s*number/i.test(last)) return last;
    }

    return '';
  }

  function extractDescriptionGeneric() {
    const multiSection = document.querySelectorAll(
      '.ashby-job-posting-section, .posting-page .section-wrapper, [data-qa="job-description"] section'
    );
    if (multiSection.length >= 2) {
      const parts = [];
      multiSection.forEach((el) => {
        const t = serializeElement(el);
        if (t && scoreDescription(t) >= 40) parts.push(t);
      });
      const joined = cleanStructuredText(parts.join('\n\n'));
      if (scoreDescription(joined) >= 120) return joined;
    }

    const selectors = [
      '[data-testid="job-description"]',
      '#jobDescriptionText',
      '.jobsearch-jobDescriptionText',
      '[data-automation-id="jobPostingDescription"]',
      '.job-description',
      '.jobDescription',
      '.job_description',
      '.description__text',
      '.description__text--rich',
      '#content .section-wrapper',
      '.posting-page .content',
      '.posting .content',
      '[class*="jobDescription"]',
      '[class*="JobDescription"]',
      '[itemprop="description"]',
      'article .content',
    ];

    let best = '';
    let bestScore = 0;
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const probe = textOf(el);
        if (/back to jobs/i.test(probe) && probe.length < 400) continue;
        const structured = serializeElement(el);
        const s = scoreDescription(structured);
        if (s > bestScore) {
          bestScore = s;
          best = structured;
        }
      } catch {
        /* ignore */
      }
    }
    if (bestScore >= 120) return best;

    try {
      const blocks = findContentBlocks();
      const structured = cleanStructuredText(blocks.map((el) => serializeElement(el)).join('\n\n'));
      const s = scoreDescription(structured);
      if (s > bestScore) {
        bestScore = s;
        best = structured;
      }
    } catch {
      /* ignore */
    }

    return best;
  }

  function extractHeuristic() {
    const ats = detectAts();
    const companyName = extractCompanyGeneric();
    const roleName = extractRoleGeneric();
    const jobDescription = extractDescriptionGeneric();
    const result = {
      companyName,
      roleName,
      jobDescription,
      location: null,
      source: 'heuristic',
      ats,
    };
    result.confidence = scoreResult(result);
    return result;
  }

  // ─── Cleaning / serialize (shared) ─────────────────────────
  function isApplicationForm(form) {
    return (
      !!form.querySelector('input[type="file"]') ||
      form.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea').length >= 3
    );
  }

  /** Hidden, decorative or UI-chrome element whose subtree should not be serialized. */
  function isSkippable(el, cs) {
    const tag = el.localName;
    if (SKIP_TAGS.has(tag)) return true;
    if (tag === 'form' && isApplicationForm(el)) return true;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.test(role)) return true;
    const cls = el.getAttribute('class') || '';
    if (HIDDEN_CLASS_RE.test(cls)) return true;
    const tokens = `${cls} ${el.id || ''}`.toLowerCase().split(/[\s_-]+/);
    if (tokens.some((t) => NOISE_CLASS_TOKENS.has(t))) return true;
    if (cs) {
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
      // Screen-reader-only text: absolutely positioned and clipped to ~1px
      if (
        cs.position === 'absolute' &&
        (cs.clip !== 'auto' || cs.clipPath !== 'none' || (parseFloat(cs.width) <= 1 && parseFloat(cs.height) <= 1))
      ) {
        return true;
      }
    }
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.length <= 40) {
      if (UI_NOISE_LINE.test(t)) return true;
      if (el.childElementCount === 0 && LEAF_BADGE.test(t)) return true;
    }
    return false;
  }

  /** Short block whose visible text is entirely bold, e.g. <p><strong>Requirements:</strong></p>. */
  function isEmphasisHeading(el, text) {
    if (!text || text.length > 80 || /[.,;!?]$/.test(text)) return false;
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let sawText = false;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      sawText = true;
      let bold = false;
      for (let p = n.parentElement; p && p !== el.parentElement; p = p.parentElement) {
        if (p.localName === 'strong' || p.localName === 'b') {
          bold = true;
          break;
        }
      }
      if (!bold) return false;
    }
    return sawText;
  }

  /**
   * Serialize a DOM subtree into light Markdown that mirrors what the reader sees:
   * - live documents use computed styles (skips hidden content, real block/inline layout, white-space: pre*)
   * - detached documents (DOMParser) fall back to tag-based layout
   * Headings → "## ", list items → "- " / "1. ", paragraphs separated by a blank line, <br> → newline.
   */
  function serializeDom(root, live) {
    let out = '';
    let pending = 0; // 0 none, 1 newline, 2 blank line
    let prefix = '';

    function brk(n) {
      if (out) pending = Math.max(pending, n);
    }
    function lineBreak() {
      if (out) pending = pending >= 1 ? 2 : 1;
    }
    function emit(s) {
      if (!s) return;
      if (!s.trim()) {
        if (out && !pending && !/[ \n]$/.test(out)) out += ' ';
        return;
      }
      if (pending) {
        out = out.replace(/ +$/, '');
        if (out) out += pending === 2 ? '\n\n' : '\n';
        pending = 0;
      }
      if (!out || /[\n ]$/.test(out)) s = s.replace(/^ +/, '');
      if (prefix) {
        out += prefix;
        prefix = '';
      }
      out += s;
    }
    function emitText(raw, pre) {
      const s = raw.replace(/[​-‍﻿]/g, '');
      if (!pre) {
        emit(s.replace(/\s+/g, ' '));
        return;
      }
      s.split('\n').forEach((part, i) => {
        if (i) lineBreak();
        emit(part.replace(/[ \t\r\f]+/g, ' '));
      });
    }
    function inlineText(el) {
      return serializeDom(el, live).replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
    }

    function walk(node, ctx, isRoot) {
      if (node.nodeType === Node.TEXT_NODE) {
        emitText(node.nodeValue, ctx.pre);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.localName;
      if (tag === 'br') {
        lineBreak();
        return;
      }
      const cs = live ? getComputedStyle(el) : null;
      if (!isRoot && isSkippable(el, cs)) return;
      if (tag === 'hr') {
        brk(2);
        emit('---');
        brk(2);
        return;
      }

      const display = cs ? cs.display : BLOCK_TAGS.has(tag) ? 'block' : 'inline';
      const block = !/^(inline|contents)/.test(display) || tag === 'li';
      const pre =
        ctx.pre || (cs ? /^(pre|pre-wrap|pre-line|break-spaces)$/.test(cs.whiteSpace) : tag === 'pre');
      const childCtx = { ...ctx, pre };

      if (!isRoot && /^h[1-6]$/.test(tag)) {
        const title = inlineText(el);
        if (title && !UI_NOISE_LINE.test(title)) {
          brk(2);
          emit(`${'#'.repeat(Math.min(Number(tag[1]), 3))} ${title}`);
          brk(2);
        }
        return;
      }

      if (tag === 'li') {
        brk(1);
        const list = el.parentElement;
        if (list?.localName === 'ol') {
          const items = Array.from(list.children).filter((c) => c.localName === 'li');
          const start = Number(list.getAttribute('start')) || 1;
          prefix = `${start + items.indexOf(el)}. `;
        } else {
          prefix = '- ';
        }
        Array.from(el.childNodes).forEach((c) => walk(c, { ...childCtx, inLi: true }));
        prefix = '';
        brk(1);
        return;
      }

      if (tag === 'ul' || tag === 'ol') {
        brk(1);
        Array.from(el.childNodes).forEach((c) => walk(c, childCtx));
        brk(ctx.inLi ? 1 : 2);
        return;
      }

      if (!block) {
        const spaced = /^inline-(block|flex|grid|table)$/.test(display);
        if (spaced) emit(' ');
        Array.from(el.childNodes).forEach((c) => walk(c, childCtx));
        if (spaced) emit(' ');
        return;
      }

      if (!ctx.inLi && !isRoot && tag !== 'td' && tag !== 'th') {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (isEmphasisHeading(el, text)) {
          brk(2);
          emit(`## ${inlineText(el).replace(/\s*:$/, '')}`);
          brk(2);
          return;
        }
      }

      let gap = 1;
      if (!ctx.inLi) {
        if (cs) {
          gap = parseFloat(cs.marginTop) >= 8 || parseFloat(cs.marginBottom) >= 8 ? 2 : 1;
        } else if (PARAGRAPH_TAGS.has(tag)) {
          gap = 2;
        }
      }
      brk(gap);
      Array.from(el.childNodes).forEach((c) => walk(c, childCtx));
      brk(gap);
    }

    walk(root, { pre: false, inLi: false }, true);
    return out.trim();
  }

  /** Visible, structured text of a live element (or of a detached element when live=false). */
  function serializeElement(el, live = true) {
    if (!el) return '';
    return cleanStructuredText(serializeDom(el, live && el.ownerDocument === document));
  }

  /** HTML string (e.g. JSON-LD description) → structured text, parsed inertly. */
  function htmlToStructured(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    return serializeElement(doc.body, false);
  }

  /** Decode entity-escaped markup like "&lt;p&gt;Hello&lt;/p&gt;" (sometimes double-escaped). */
  function decodeEntities(s) {
    let text = String(s || '');
    for (let i = 0; i < 2; i++) {
      if (/<[a-z][^>]*>/i.test(text) || !/&(lt|gt|amp|quot|nbsp|#\d+|#x[0-9a-f]+);/i.test(text)) break;
      text = new DOMParser().parseFromString(text, 'text/html').body.textContent || '';
    }
    return text;
  }

  /**
   * Readability-style pick of the main content block(s): score paragraph-like nodes,
   * propagate to ancestors, penalize link-heavy and chrome-like containers.
   * Unlike "longest container wins", this avoids grabbing page wrappers with sidebars / related jobs.
   */
  function findContentBlocks() {
    const scope = document.querySelector('main, [role="main"], article') || document.body;
    if (!scope) return [];
    const scores = new Map();
    const add = (el, v) => {
      if (el && el !== document.documentElement && scope.contains(el)) scores.set(el, (scores.get(el) || 0) + v);
    };
    const visible = (el) => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);
    const chrome = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"]';

    const paras = Array.from(scope.querySelectorAll('p, li, pre, td, blockquote'));
    scope.querySelectorAll('div, span').forEach((el) => {
      const direct = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.nodeValue)
        .join('')
        .trim();
      if (direct.length >= 40) paras.push(el);
    });

    for (const p of paras) {
      if (p.closest(chrome) || !visible(p)) continue;
      const text = (p.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 25) continue;
      const s = 1 + (text.match(/,/g) || []).length + Math.min(Math.floor(text.length / 100), 3);
      add(p.parentElement, s);
      add(p.parentElement?.parentElement, s / 2);
      add(p.parentElement?.parentElement?.parentElement, s / 3);
    }

    const weight = (el) => {
      const label = `${el.getAttribute('class') || ''} ${el.id || ''}`.toLowerCase();
      let w = 0;
      if (/description|posting|job|content|article|details|body/.test(label)) w += 25;
      if (/comment|sidebar|aside|related|similar|recommend|nav|menu|footer|header|share|social|cookie|banner|modal|apply|promo/.test(label)) {
        w -= 25;
      }
      return w;
    };
    const linkDensity = (el) => {
      const total = (el.textContent || '').length || 1;
      let links = 0;
      el.querySelectorAll('a').forEach((a) => (links += (a.textContent || '').length));
      return links / total;
    };

    let top = null;
    let topScore = 0;
    const final = new Map();
    scores.forEach((s, el) => {
      const v = (s + weight(el)) * (1 - linkDensity(el));
      final.set(el, v);
      if (v > topScore) {
        topScore = v;
        top = el;
      }
    });
    if (!top) return [];

    // Include strong siblings (descriptions split across adjacent sections), in DOM order
    const parent = top.parentElement;
    if (!parent) return [top];
    const threshold = Math.max(10, topScore * 0.2);
    return Array.from(parent.children).filter((c) => c === top || (final.get(c) || 0) >= threshold);
  }

  function cleanStructuredText(text) {
    const rawLines = String(text || '').split(/\r?\n/);
    const out = [];

    for (let line of rawLines) {
      line = line.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
      if (!line) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        continue;
      }

      line = line.replace(/^([•-])\s*[•-]\s+/, '$1 ');
      if (UI_NOISE_LINE.test(line.replace(/^#+\s*/, '').replace(/^[•-]\s*/, ''))) continue;
      if (/^#{1,3}\s*(back to|apply|new)\b/i.test(line)) continue;
      if (/^(📍|📌)/u.test(line)) continue;
      if (/^(location|workplace type|department|employment type)\s*[:|]?\s*$/i.test(line)) continue;
      if (/back to jobs/i.test(line) && line.length < 80) continue;
      if (/^(apply|new){1,3}$/i.test(line.replace(/\s+/g, ''))) continue;

      out.push(line);
    }

    return out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 20000);
  }

  function cleanPlainText(text) {
    return cleanStructuredText(
      String(text || '')
        .replace(/\r/g, '')
        .split('\n')
        .map((l) => l.trim())
        .join('\n')
    );
  }

  function scoreDescription(text) {
    if (!text) return 0;
    let score = Math.min(text.length, 4000) / 10;
    if (/^#+\s+/m.test(text)) score += 40;
    if (/^•\s+/m.test(text) || /^-\s+/m.test(text)) score += 40;
    if (/\n\n/.test(text)) score += 20;
    if (/responsibilit|qualifi|requirement|about (the )?role|what you|benefits|you will/i.test(text))
      score += 50;
    if (/back to jobs|easy apply/i.test(text)) score -= 80;
    return score;
  }

  function scoreResult(result) {
    let c = 0.2;
    if (result.companyName && result.companyName.length > 1) c += 0.2;
    if (result.roleName && result.roleName.length > 2 && !isBadRoleTitle(result.roleName)) c += 0.2;
    if (isBadRoleTitle(result.roleName)) c -= 0.35;
    // Company that looks like a job title is almost certainly wrong
    if (result.companyName && (/job\s*number/i.test(result.companyName) || result.companyName.length > 80)) {
      c -= 0.3;
    }
    const descScore = scoreDescription(result.jobDescription || '');
    c += Math.min(0.45, descScore / 400);
    if (result.source === 'json-ld') c += 0.15;
    if (String(result.source || '').startsWith('ats:')) c += 0.08;
    if (result.ats === 'taleo' && String(result.source || '').includes('taleo')) c += 0.05;
    if (/back to jobs|easy apply/i.test(result.jobDescription || '')) c -= 0.25;
    if (!result.companyName || !result.roleName || isBadRoleTitle(result.roleName)) c -= 0.15;
    if (!(result.jobDescription && result.jobDescription.length > 80)) c -= 0.1;
    return Math.max(0, Math.min(0.98, c));
  }

  /**
   * Clean page text suitable for LLM (main content, noise stripped).
   */
  function getPageTextForLlm() {
    const taleoRoot = document.querySelector(
      '.editablesection, [id*="requisitionDescriptionInterface"], .contentlinepanel'
    );
    const root =
      taleoRoot ||
      document.querySelector('main, article, [role="main"], #content, .content') ||
      document.body;
    let text = serializeElement(root);
    if (!text || text.length < 80) {
      text = cleanPlainText(textOf(root));
    }
    // Prefer keeping description-ish length for the model
    return text.slice(0, 12000);
  }

  function mergeBest(candidates) {
    const valid = candidates.filter(Boolean);
    if (!valid.length) {
      return {
        companyName: '',
        roleName: '',
        jobDescription: '',
        location: null,
        source: 'none',
        ats: detectAts(),
        confidence: 0,
      };
    }
    valid.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const top = { ...valid[0] };

    // Fill missing fields from other candidates
    for (const other of valid.slice(1)) {
      if (!top.companyName && other.companyName) top.companyName = other.companyName;
      if (!top.roleName && other.roleName) top.roleName = other.roleName;
      if (
        (!top.jobDescription || top.jobDescription.length < 120) &&
        other.jobDescription &&
        other.jobDescription.length > (top.jobDescription || '').length
      ) {
        top.jobDescription = other.jobDescription;
      }
    }
    top.confidence = scoreResult(top);
    top.needsLlm = top.confidence < CONFIDENCE_OK;
    return top;
  }

  /**
   * Local hybrid extract (no network). Sets needsLlm when confidence is low.
   */
  HS.extractJobInfoLocal = function extractJobInfoLocal() {
    const ats = detectAts();
    const jsonLd = extractJsonLd();
    const atsResult = ats !== 'generic' ? extractByAts(ats) : null;
    const heuristic = extractHeuristic();
    const result = mergeBest([jsonLd, atsResult, heuristic]);
    result.sourceUrl = location.href;
    result.extractedAt = new Date().toISOString();
    result.pageTitle = document.title;
    result.ats = ats;

    // Fix common swaps / section-header titles
    if (isBadRoleTitle(result.roleName)) {
      result.roleName =
        (atsResult && !isBadRoleTitle(atsResult.roleName) && atsResult.roleName) ||
        extractRoleGeneric() ||
        '';
    }
    if (
      !result.companyName ||
      isBadRoleTitle(result.companyName) ||
      /job\s*number/i.test(result.companyName) ||
      result.companyName.length > 80
    ) {
      result.companyName = companyFromLogo() || companyFromHost() || result.companyName || '';
      if (isBadRoleTitle(result.companyName) || /job\s*number/i.test(result.companyName || '')) {
        result.companyName = companyFromHost() || '';
      }
    }
    if ((!result.jobDescription || result.jobDescription.length < 80) && ats === 'taleo') {
      const d = extractTaleoDescription();
      if (d && d.length > (result.jobDescription || '').length) result.jobDescription = d;
    }

    if (result.jobDescription) {
      result.jobDescription = HS.structureJobDescription
        ? HS.structureJobDescription(result.jobDescription)
        : cleanStructuredText(result.jobDescription);
    }
    result.confidence = scoreResult(result);
    result.descriptionScore = scoreDescription(result.jobDescription || '');
    result.needsLlm = result.confidence < CONFIDENCE_OK;
    return result;
  };

  /**
   * Back-compat sync extract (local only).
   */
  HS.extractJobInfo = function extractJobInfo() {
    return HS.extractJobInfoLocal();
  };

  HS.getPageTextForLlm = getPageTextForLlm;
  HS.cleanJobDescription = cleanStructuredText;
  HS.CONFIDENCE_OK = CONFIDENCE_OK;
})();
