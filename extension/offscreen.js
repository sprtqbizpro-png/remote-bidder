/**
 * Plays a short two-tone chime when an applied job is saved.
 * Runs in an offscreen document so MV3 service workers can trigger audio.
 */
function playSaveChime() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const now = ctx.currentTime;
  const beep = (start, freq, dur) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.28, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  };
  beep(now, 880, 0.16);
  beep(now + 0.18, 1175, 0.24);
  setTimeout(() => {
    try {
      ctx.close();
    } catch {
      /* ignore */
    }
  }, 900);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'OFFSCREEN_PLAY_SAVE_SOUND') return undefined;
  try {
    playSaveChime();
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || 'Sound failed' });
  }
  return true;
});
