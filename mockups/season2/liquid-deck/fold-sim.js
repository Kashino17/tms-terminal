// TMSSim — deterministic scripted playback of a terminal session.
// immediate:true runs synchronously (tests); otherwise setTimeout-driven with speed multiplier.
(function (global) {
  function createSession(script, opts) {
    opts = Object.assign({ speed: 1, immediate: false, autoApprove: false, autoApproveDelay: 600 }, opts);
    const listeners = {};
    let i = 0, timer = null, autoTimer = null, epoch = 0;
    const api = {
      state: 'idle',
      on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return api; },
      start() { if (api.state !== 'idle') return; api.state = 'playing'; step(); },
      respond() {
        if (api.state !== 'awaiting-prompt') return;
        clearTimeout(autoTimer); // manual answer must disarm a pending auto-approve
        api.state = 'playing'; i++; step();
      },
      reset() { clearTimeout(timer); clearTimeout(autoTimer); epoch++; i = 0; api.state = 'idle'; },
    };
    function emit(ev, data) { (listeners[ev] || []).forEach(cb => cb(data)); }
    function schedule(fn, ms, isAuto) {
      if (opts.immediate) { fn(); return; }
      const e = epoch; // timers armed before a reset() must never fire into the replay
      const id = setTimeout(() => { if (e === epoch) fn(); }, ms / opts.speed);
      if (isAuto) autoTimer = id; else timer = id;
    }
    function step() {
      if (i >= script.length) return;
      const ev = script[i];
      schedule(() => {
        emit(ev.type, ev.data);
        if (ev.type === 'done') { api.state = 'done'; return; }
        if (ev.type === 'prompt') {
          api.state = 'awaiting-prompt';
          if (opts.autoApprove) schedule(() => api.respond(), opts.autoApproveDelay, true);
          return;
        }
        i++; step();
      }, ev.t);
    }
    return api;
  }
  const TMSSim = { createSession };
  global.TMSSim = TMSSim;
  if (typeof module !== 'undefined' && module.exports) module.exports = TMSSim;
})(typeof window !== 'undefined' ? window : globalThis);
