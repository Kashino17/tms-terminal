/**
 * Bridge — turns the Liquid-Deck mockup into the real app.
 *
 * Injected AFTER the mockup's own script, so every top-level `function foo()`
 * it declared is a global we can replace: reassigning window.foo rebinds the
 * call sites inside the mockup too. Its markup, CSS, gestures and animations
 * stay untouched — that is the whole point.
 *
 * What gets swapped:
 *   card body    fake escaped-HTML lines  ->  a real xterm.js instance
 *   input row    demo echo                ->  terminal:input over the WebSocket
 *   sim          scripted playback        ->  real PTY output (window.__tmsSim)
 *   mic          fake 2s "transcribing"   ->  native recorder + server Whisper
 */
(function () {
  var RN = window.ReactNativeWebView;
  function post(type, payload) {
    try { RN.postMessage(JSON.stringify({ type: type, payload: payload || {} })); } catch (e) {}
  }

  var terms = {};        // cardId -> { term, fit }
  var bound = {};        // cardId -> sessionId | 'pending'
  var byCard = {};       // cardId -> sessionId (resolved only)
  var queued = {};       // sessionId -> [chunk] — arrived before its card existed
  var restoring = false;

  window.__tmsLastLine = {};

  function cardOf(sessionId) {
    for (var id in byCard) if (byCard[id] === sessionId) return id;
    return null;
  }

  // ── The mockup asks for this while building cardState (see the builder's
  //    source patch). Every card therefore owns a "sim" that talks to the PTY,
  //    which keeps resolvePrompt()/submitQuestionAnswer() working unchanged.
  window.__tmsInput = function (cardId, data) {
    var sid = byCard[cardId];
    if (sid) post('terminal:input', { sessionId: sid, data: data });
  };
  window.__tmsSim = function (cardId) {
    return {
      on: function () { return this; },
      start: function () {},
      reset: function () {},
      respond: function (answer) {
        if (typeof answer === 'string' && answer) window.__tmsInput(cardId, answer + '\r');
        else if (answer === false) window.__tmsInput(cardId, '\x1b');
        else window.__tmsInput(cardId, '\r');
      },
    };
  };

  // ── xterm per card ────────────────────────────────────────────────────────
  function xtermTheme() {
    var cs = getComputedStyle(document.documentElement);
    return {
      background: 'rgba(0,0,0,0)',
      foreground: cs.getPropertyValue('--text').trim() || '#f0f2f6',
      cursor: cs.getPropertyValue('--accent').trim() || '#8ab8ff',
      selectionBackground: 'rgba(138,184,255,0.35)',
    };
  }

  function mountTerm(cardId) {
    var host = document.querySelector('.card-body[data-card-id="' + cardId + '"]');
    if (!host || terms[cardId]) return;
    host.innerHTML = '';
    host.classList.add('is-xterm');
    var term = new window.Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: xtermTheme(),
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try { fit.fit(); } catch (e) {}
    term.onData(function (d) { window.__tmsInput(cardId, d); });
    term.onResize(function (sz) {
      var sid = byCard[cardId];
      if (sid) post('terminal:resize', { sessionId: sid, cols: sz.cols, rows: sz.rows });
    });
    terms[cardId] = { term: term, fit: fit };
    flush(cardId);
  }

  function flush(cardId) {
    var sid = byCard[cardId];
    var t = terms[cardId];
    if (!sid || !t || !queued[sid]) return;
    queued[sid].forEach(function (c) { t.term.write(c); });
    delete queued[sid];
  }

  // Cards appear/disappear whenever the mockup rebuilds its workspace (Stack ⇄
  // Liste, new terminal, overview). Follow the DOM instead of duplicating that
  // logic: an unseen card means a terminal we still have to create server-side.
  var timer = null;
  function syncTerms() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      document.querySelectorAll('.card-body[data-card-id]').forEach(function (host) {
        var cardId = host.getAttribute('data-card-id');
        if (!terms[cardId]) mountTerm(cardId);
        else { try { terms[cardId].fit.fit(); } catch (e) {} }
        if (!restoring && !(cardId in bound)) {
          bound[cardId] = 'pending';
          post('terminal:create', { cardId: cardId });
        }
      });
      Object.keys(terms).forEach(function (cardId) {
        if (!document.querySelector('.card-body[data-card-id="' + cardId + '"]')) {
          try { terms[cardId].term.dispose(); } catch (e) {}
          delete terms[cardId];
        }
      });
    }, 50);
  }
  new MutationObserver(syncTerms).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', function () {
    Object.keys(terms).forEach(function (id) { try { terms[id].fit.fit(); } catch (e) {} });
  });

  // ── Replace the mockup's demo plumbing ────────────────────────────────────
  window.renderCardLines = function () { /* xterm owns the card body now */ };
  window.initLiveSession = function () { /* no simulator — output comes from the PTY */ };
  window.startQuestionScript = function () {};
  window.scheduleQuestionScript = function () {};
  window.showReplay = function () {};
  window.replaySession = function () {};
  window.startLatencyTicker = function () { /* React Native drives the real RTT */ };

  window.sendTerminalCommand = function (id, cmd) {
    if (cmd && cmd.trim()) window.__tmsInput(id, cmd.trim() + '\r');
  };
  window.sendCtrlC = function (id) {
    window.__tmsInput(id, '\x03');
    if (typeof window.toast === 'function') window.toast('^C gesendet');
  };
  window.handleTermKey = function (key, id) {
    var seq = { ctrlc: '\x03', esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' }[key];
    if (seq) window.__tmsInput(id, seq);
    if (typeof window.flashKeyEcho === 'function') {
      window.flashKeyEcho(key === 'ctrlc' ? '^C' : key === 'esc' ? 'Esc' : key === 'tab' ? 'Tab' : key);
    }
  };
  window.clearActiveTerminal = function (id) {
    if (terms[id]) terms[id].term.clear();
    if (typeof window.toast === 'function') window.toast('Geleert');
  };
  window.scrollTerminalToBottom = function (id) {
    if (terms[id]) terms[id].term.scrollToBottom();
  };
  window.copyText = function (text) { post('clipboard:write', { text: text }); };

  // Real dictation: keep the mockup's exact visual states, drop its fake timers.
  window.startDictation = function (cardId) {
    var card = document.querySelector('.term-card[data-id="' + cardId + '"]');
    var input = card && card.querySelector('.term-input');
    var mic = card && card.querySelector('.term-mic-btn');
    if (!input || !mic) return;
    input.disabled = true;
    input.placeholder = 'Höre zu…';
    mic.classList.add('is-recording');
    if (typeof window.setIslandMicBadge === 'function') window.setIslandMicBadge(true);
    post('mic:start', { cardId: cardId });
  };

  // Auto-Approve lives in React Native (it must keep working while the
  // terminals screen is closed), so mirror every toggle out to it.
  var origToggle = window.toggleCardAutoApprove;
  window.toggleCardAutoApprove = function (id) {
    origToggle(id);
    var on = !!(document.querySelector('.term-card[data-id="' + id + '"] .auto-toggle.is-on'));
    post('autoapprove:set', { cardId: id, sessionId: byCard[id], enabled: on });
  };

  // ── React Native → WebView ────────────────────────────────────────────────
  window.TMSBridge = {
    /** Re-create cards for PTY sessions that already exist on the server. */
    restoreSessions: function (list) {
      restoring = true;
      list.forEach(function (item) {
        window.addTerminal();
        var ids = [].map.call(document.querySelectorAll('.card-body[data-card-id]'), function (el) {
          return el.getAttribute('data-card-id');
        });
        var cardId = ids.filter(function (id) { return !(id in bound); }).pop();
        if (!cardId) return;
        bound[cardId] = item.sessionId;
        byCard[cardId] = item.sessionId;
        mountTerm(cardId);
        post('terminal:attach', { cardId: cardId, sessionId: item.sessionId });
      });
      restoring = false;
      // addTerminal() arms the rename field for a brand-new terminal; a restored
      // one is not new, so drop that focus again.
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      window.getSelection && window.getSelection().removeAllRanges();
    },
    /** A PTY session was created for a card we asked about. */
    bindSession: function (cardId, sessionId) {
      bound[cardId] = sessionId;
      byCard[cardId] = sessionId;
      mountTerm(cardId);
      flush(cardId);
      var t = terms[cardId];
      post('terminal:attach', { cardId: cardId, sessionId: sessionId, cols: t && t.term.cols, rows: t && t.term.rows });
    },
    /** PTY output. */
    output: function (sessionId, chunk) {
      var cardId = cardOf(sessionId);
      if (!cardId || !terms[cardId]) { (queued[sessionId] = queued[sessionId] || []).push(chunk); return; }
      terms[cardId].term.write(chunk);
      var plain = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').filter(function (l) { return l.trim(); }).pop();
      if (plain) window.__tmsLastLine[cardId] = plain;
    },
    /** Session state -> the mockup's own status chip. */
    setSessionStatus: function (sessionId, status) {
      var cardId = cardOf(sessionId);
      if (cardId && typeof window.updateStatusChip === 'function') window.updateStatusChip(cardId, status);
    },
    /** A permission / question prompt from the AI tool. */
    prompt: function (sessionId, data) {
      var cardId = cardOf(sessionId);
      if (cardId && typeof window.handlePrompt === 'function') window.handlePrompt(cardId, data);
    },
    /** Connection state -> Dynamic Island + latency chips. */
    setStatus: function (info) {
      if (typeof window.setIslandActivity === 'function') window.setIslandActivity(info.kind || 'ok', info.label || '');
      var srv = (window.TMS_DATA.servers || [])[0];
      if (srv) {
        if (info.latency != null) srv.latency = info.latency;
        if (info.name) srv.name = info.name;
        srv.status = info.kind === 'idle' ? 'offline' : 'online';
      }
      if (typeof window.updateLatencyDisplay === 'function') window.updateLatencyDisplay();
    },
    /** Whisper result -> back into the card's input row. */
    dictationResult: function (cardId, text) {
      var card = document.querySelector('.term-card[data-id="' + cardId + '"]');
      var input = card && card.querySelector('.term-input');
      var mic = card && card.querySelector('.term-mic-btn');
      if (mic) mic.classList.remove('is-recording', 'is-transcribing');
      if (input) {
        input.disabled = false;
        input.placeholder = 'Befehl eingeben…';
        if (text) { input.value = (input.value ? input.value + ' ' : '') + text; input.focus(); }
      }
      if (typeof window.setIslandMicBadge === 'function') window.setIslandMicBadge(false);
    },
    /** Whisper is running — the mockup already has a state for that. */
    dictationTranscribing: function (cardId) {
      var card = document.querySelector('.term-card[data-id="' + cardId + '"]');
      var mic = card && card.querySelector('.term-mic-btn');
      var input = card && card.querySelector('.term-input');
      if (mic) { mic.classList.remove('is-recording'); mic.classList.add('is-transcribing'); }
      if (input) input.placeholder = 'Transkribiere…';
      if (typeof window.setIslandMicBadge === 'function') window.setIslandMicBadge(false);
    },
    toast: function (msg) { if (typeof window.toast === 'function') window.toast(msg); },
  };

  post('bridge:ready', {});
})();
