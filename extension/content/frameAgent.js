/**
 * King Star frame agent — runs inside iframes only.
 *
 * Company careers pages often embed the real application form from an ATS in an iframe
 * (Greenhouse "grnhse_iframe", Lever, Workday, iCIMS, …). The panel lives in the top page and
 * cannot reach into a cross-origin frame, so this agent does the filling inside the frame
 * when the panel asks (via background FRAMES_PROBE / FRAME_CALL), and streams progress back.
 */
(function () {
  if (window === window.top) return;
  const HS = window.HiddenStar;
  if (!HS || !HS.collectQuestions) return;
  // Same rule as content.js: a copy left over from before an extension reload doesn't count
  if (HS.__frameAgentRuntime && HS.__frameAgentRuntime === chrome.runtime && chrome.runtime?.id) return;
  HS.__frameAgentRuntime = chrome.runtime;
  const ownRuntime = chrome.runtime;

  let cancelled = false;

  function send(type, payload) {
    try {
      if (!ownRuntime?.id) return Promise.reject(new Error('Extension context invalidated'));
      return ownRuntime.sendMessage({ type, payload });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function dataUrlToFile(dataUrl, name, mime) {
    const [head, b64] = String(dataUrl).split(',');
    const type = mime || (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
    const bin = atob(b64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name || 'resume.pdf', { type });
  }

  const questionKey = (t) =>
    String(t || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  /** What this frame has to fill (null when nothing — e.g. ads, video players, captchas). */
  HS.frameProbe = function frameProbe() {
    try {
      const questions = HS.collectQuestions().length;
      const resumeInputs = HS.findResumeInputs ? HS.findResumeInputs().length : 0;
      const history = !!HS.hasHistorySections?.();
      if (!questions && !resumeInputs && !history) return null;
      return { questions, resumeInputs, history, url: location.href };
    } catch {
      return null;
    }
  };

  function plainItem(item) {
    return {
      id: item.id,
      question: item.question,
      required: !!item.required,
      filled: !!item.filled,
      source: item.source || null,
      intent: item.intent || null,
    };
  }

  function progress(item) {
    send('FRAME_PROGRESS', { item: plainItem(item) }).catch(() => {});
  }

  function startLearning() {
    if (!HS.startAnswerLearning) return;
    const save = (pairs) =>
      pairs?.length
        ? send('SAVE_FIXED_ANSWERS_BULK', { answers: pairs, onlyRepetitive: true }).catch(() => {})
        : null;
    HS.startAnswerLearning(save, { debounceMs: 900, onFieldChange: (pair) => save([pair]) });
  }

  async function autofill(args = {}) {
    cancelled = false;
    const { info = {}, resume = null, resumeContext = '', history = null } = args;
    const rows = new Map();
    const upsert = (item) => {
      const it = plainItem(item);
      // The file input also shows up as a "Resume/CV" question — it's the same row
      if (it.id !== '__resume__' && rows.has('__resume__') && /^(resume|cv)\b/i.test(questionKey(it.question))) return;
      rows.set(it.id || questionKey(it.question), it);
      progress(it);
    };
    let filled = 0;
    let resumeFilled = 0;
    let meta = {};

    // 1) Resume file (+ the form's own "autofill from resume", when it has one)
    const host = HS.detectHostResumeAutofill ? HS.detectHostResumeAutofill() : null;
    const resumeInputs = HS.findResumeInputs ? HS.findResumeInputs() : [];
    if (resume?.dataUrl && HS.fillResumeInputs) {
      const file = dataUrlToFile(resume.dataUrl, resume.name, resume.mime);
      resumeFilled = HS.fillResumeInputs(file) || 0;
      if (host && HS.feedHostResumeAutofill) resumeFilled += HS.feedHostResumeAutofill(host, file) || 0;
    }
    if (resumeInputs.length || host) {
      upsert({ id: '__resume__', question: 'Resume/CV', required: true, filled: resumeFilled > 0, source: resumeFilled ? 'page' : null });
    }
    if (host && !host.isComplete() && HS.waitForHostResumeAutofill) {
      await HS.waitForHostResumeAutofill({
        timeoutMs: 45000,
        pollMs: 350,
        hostRoot: host.root,
        shouldCancel: () => cancelled,
      });
    }
    if (cancelled) throw new Error('cancelled');

    // 2) Ask for answers now; the server works while history fields are being filled
    const generateFor = (qs) =>
      send('GENERATE_ANSWERS', {
        questions: qs.map(({ id, question, tag, type, placeholder, options }) => ({
          id,
          question,
          tag,
          type,
          placeholder,
          options: HS.serializableOptions ? HS.serializableOptions(options) : options,
        })),
        companyName: info.companyName,
        roleName: info.roleName,
        jobDescription: info.jobDescription,
        resumeContext,
      });
    const fillable = (list) =>
      list.map((a) =>
        HS.isCoverLetterField?.(a.question, { placeholder: a.placeholder }) || /cover\s*letter/i.test(a.question || '')
          ? { ...a, answer: '' }
          : a
      );
    const asked = HS.collectQuestions();
    const pending = asked.length ? generateFor(asked) : null;

    // 3) Work / Employment history + Education from the parsed resume
    if (history && HS.fillHistory && HS.hasHistorySections?.()) {
      const hist = await HS.fillHistory(history, { shouldCancel: () => cancelled });
      for (const e of hist.entries) {
        upsert({
          id: `__history_${e.section}_${e.index}__`,
          question: `${e.section === 'work' ? 'Work history' : 'Education'} ${e.index + 1}: ${e.label}`,
          required: false,
          filled: e.filled,
          source: e.filled ? 'resume' : 'unmatched',
        });
      }
    }
    if (cancelled) throw new Error('cancelled');

    // 4) Fill answers, then follow-up questions revealed by those answers
    if (pending) {
      const res = await pending;
      if (!res?.ok) throw new Error(res?.error || 'Could not get answers');
      meta = res.data.meta || {};
      const r = await HS.fillAnswers(fillable(res.data.answers || []), { onItem: upsert });
      filled += r?.filled || 0;
      (r?.items || []).forEach(upsert);

      const askedKeys = new Set(asked.map((q) => questionKey(q.question)));
      for (let pass = 0; pass < 3 && !cancelled; pass++) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const fresh = HS.collectQuestions().filter((q) => {
          const k = questionKey(q.question);
          return k && !askedKeys.has(k);
        });
        if (!fresh.length) break;
        fresh.forEach((q) => askedKeys.add(questionKey(q.question)));
        const more = await generateFor(fresh);
        if (!more?.ok) break;
        const r2 = await HS.fillAnswers(fillable(more.data.answers || []), { onItem: upsert, onlyListed: true });
        filled += r2?.filled || 0;
      }
    }

    // 5) Remember what ended up on the form, and keep learning from the user's edits
    let remembered = 0;
    try {
      const pairs = HS.collectFilledAnswers ? HS.collectFilledAnswers() : [];
      if (pairs.length) {
        const saved = await send('SAVE_FIXED_ANSWERS_BULK', { answers: pairs, onlyRepetitive: true });
        remembered = saved?.data?.saved || 0;
      }
    } catch {
      /* non-fatal */
    }
    startLearning();

    const list = [...rows.values()];
    const unique = HS.dedupeQuestionItems ? HS.dedupeQuestionItems(list).map(plainItem) : list;
    return { rows: unique, filled, resumeFilled, meta, remembered, url: location.href };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'HS_FRAME_OP') return undefined;
    let run;
    if (msg.op === 'probe') run = Promise.resolve(HS.frameProbe());
    else if (msg.op === 'autofill') run = autofill(msg.args);
    else if (msg.op === 'cancel') {
      cancelled = true;
      run = Promise.resolve(true);
    } else run = Promise.reject(new Error(`Unknown frame op: ${msg.op}`));
    run
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  });
})();
