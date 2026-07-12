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

  var terms = {};        // cardId -> { term, fit, element, host }
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

  /**
   * The mockup's selection (tap a line, drag the handles, "Kopieren") is built
   * on .term-line elements. Give xterm's rendered rows that same shape and the
   * whole machinery works on real terminal output, untouched.
   */
  function tagRows(cardId) {
    var t = terms[cardId];
    if (!t || !t.element) return;
    var rows = t.element.querySelectorAll('.xterm-rows > div');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.add('term-line');
      rows[i].dataset.i = i;
    }
  }

  /**
   * Never measure a terminal that has no size yet: the WebView reports 0×0 on
   * its first frames, and fitting against that yields 0 rows — an empty box and
   * a resize the server rejects outright. Wait for a real box, then fit.
   */
  function fitSoon(cardId) {
    var t = terms[cardId];
    if (!t) return;
    clearTimeout(t.fitTimer);
    t.fitTimer = setTimeout(function () {
      var host = t.host;
      if (!host || !host.clientWidth || !host.clientHeight) {
        if ((t.fitTries = (t.fitTries || 0) + 1) < 40) fitSoon(cardId);
        return;
      }
      t.fitTries = 0;
      try { t.fit.fit(); } catch (e) {}
      tagRows(cardId);
    }, 60);
  }

  function mountTerm(cardId) {
    var host = document.querySelector('.card-body[data-card-id="' + cardId + '"]');
    if (!host) return;
    var t = terms[cardId];

    // The mockup rebuilds every card from scratch on a view switch (Stack ⇄
    // Liste), a reorder or a new terminal. Move the live xterm into the new
    // body instead of recreating it — the scrollback survives, and without this
    // the terminal stays attached to the discarded node and the card goes blank.
    if (t) {
      if (t.host !== host) {
        host.innerHTML = '';
        host.classList.add('is-xterm');
        host.appendChild(t.element);
        t.host = host;
      }
      fitSoon(cardId);
      return;
    }

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
    // A tapped link copies itself — the same thing the mockup's wrapped link did.
    if (window.WebLinksAddon) {
      term.loadAddon(new window.WebLinksAddon.WebLinksAddon(function (event, uri) {
        post('clipboard:write', { text: uri });
        if (typeof window.toast === 'function') window.toast('Link kopiert ✓');
      }));
    }
    term.open(host);

    term.onData(function (d) { window.__tmsInput(cardId, d); });
    term.onResize(function (sz) {
      var sid = byCard[cardId];
      if (sid && sz.cols > 0 && sz.rows > 0) {
        post('terminal:resize', { sessionId: sid, cols: sz.cols, rows: sz.rows });
      }
    });
    term.onRender(function () { tagRows(cardId); });

    terms[cardId] = { term: term, fit: fit, element: term.element, host: host };
    var vp = term.element.querySelector('.xterm-viewport');
    if (vp) vp.addEventListener('scroll', function () { window.updateJumpOrb(cardId); });
    fitSoon(cardId);
    flush(cardId);
  }

  function flush(cardId) {
    var sid = byCard[cardId];
    var t = terms[cardId];
    if (!sid || !t || !queued[sid]) return;
    queued[sid].forEach(function (c) { t.term.write(c); });
    delete queued[sid];
  }

  /** Whatever the page tells the server about a terminal's size must be real. */
  function dims(cardId) {
    var t = terms[cardId];
    return {
      cols: (t && t.term.cols) || 80,
      rows: (t && t.term.rows) || 24,
    };
  }

  // Cards appear/disappear whenever the mockup rebuilds its workspace. Follow
  // the DOM instead of duplicating that logic: an unseen card means a terminal
  // we still have to create server-side.
  var timer = null;
  function syncTerms() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      document.querySelectorAll('.card-body[data-card-id]').forEach(function (host) {
        var cardId = host.getAttribute('data-card-id');
        mountTerm(cardId); // mounts, or re-homes an existing terminal
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
  // Watch for cards appearing and disappearing — but xterm rewrites its rows on
  // every single chunk of output, and reacting to that made syncTerms re-measure
  // every card continuously. That was the scroll jank. Ignore anything that
  // happens inside a terminal.
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var t = records[i].target;
      if (t.nodeType === 1 && t.closest && t.closest('.xterm')) continue;
      syncTerms();
      return;
    }
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', function () {
    Object.keys(terms).forEach(fitSoon);
  });

  // ── Der „schnell nach unten“-Orb ──────────────────────────────────────────
  // Das Mockup maß den Scrollstand der .card-body. Mit xterm scrollt aber der
  // Viewport darin, die Karte selbst steht still — der Orb kam deshalb nie.
  window.updateJumpOrb = function (id, pulse) {
    var card = document.querySelector('.term-card[data-id="' + id + '"]');
    var t = terms[id];
    if (!card || !t) return;
    var btn = card.querySelector('.jump-bottom-orb');
    var vp = t.element && t.element.querySelector('.xterm-viewport');
    if (!btn || !vp) return;
    var atBottom = vp.scrollHeight - vp.scrollTop - vp.clientHeight < 24;
    btn.classList.toggle('show', !atBottom);
    if (atBottom) btn.classList.remove('pulse');
    else if (pulse) btn.classList.add('pulse');
  };

  // ── Replace the mockup's demo plumbing ────────────────────────────────────
  // Not a no-op: xterm owns the pixels, but the mockup still expects this to
  // (re)establish the per-line elements its selection UI works on.
  window.renderCardLines = function (id) { tagRows(id); };
  window.initLiveSession = function () { /* no simulator — output comes from the PTY */ };
  window.startQuestionScript = function () {};
  window.scheduleQuestionScript = function () {};
  window.showReplay = function () {};
  window.replaySession = function () {};
  window.startLatencyTicker = function () { /* React Native drives the real RTT */ };

  // Copy the selected rows. The mockup read a .term-line__text child that an
  // xterm row does not have — take the row's own text instead.
  window.makeBubble = function (cardId) {
    var el = document.createElement('button');
    el.className = 'copy-bubble';
    el.textContent = 'Kopieren';
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      var pre = document.querySelector('.card-body[data-card-id="' + cardId + '"]');
      var sel = pre ? pre.querySelectorAll('.term-line.is-selected') : [];
      if (!sel.length) return;
      var text = [].map.call(sel, function (l) { return l.textContent.replace(/\s+$/, ''); }).join('\n');
      post('clipboard:write', { text: text });
      if (typeof window.toast === 'function') window.toast('Kopiert ✓');
      if (typeof window.clearSelection === 'function') window.clearSelection(cardId);
    });
    return el;
  };

  // The handles and the copy bubble were positioned off a .term-line__text
  // child that an xterm row has no equivalent for. Measure the rows themselves
  // — and against the card body, since they live in a scrolled viewport.
  window.positionHandlesAndBubble = function (cardId) {
    var pre = document.querySelector('.card-body[data-card-id="' + cardId + '"]');
    if (!pre) return;
    var hs = pre.querySelector('.sel-handle--start');
    var he = pre.querySelector('.sel-handle--end');
    var bubble = pre.querySelector('.copy-bubble');
    var sel = pre.querySelectorAll('.term-line.is-selected');
    if (!sel.length) {
      [hs, he, bubble].forEach(function (el) { if (el) el.remove(); });
      return;
    }
    if (!hs) { hs = window.makeHandle('start', cardId); pre.appendChild(hs); }
    if (!he) { he = window.makeHandle('end', cardId); pre.appendChild(he); }
    if (!bubble) { bubble = window.makeBubble(cardId); pre.appendChild(bubble); }
    var base = pre.getBoundingClientRect();
    var first = sel[0].getBoundingClientRect();
    var last = sel[sel.length - 1].getBoundingClientRect();
    hs.style.top = (first.bottom - base.top) + 'px';
    hs.style.left = (first.left - base.left) + 'px';
    he.style.top = (last.bottom - base.top) + 'px';
    he.style.left = (last.right - base.left) + 'px';
    bubble.style.top = Math.max(0, first.top - base.top - 38) + 'px';
    bubble.style.left = (first.left - base.left) + 'px';
  };

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

  // Real dictation. The bar's own recording UI (trace, timer, ✓/✕) stays; only
  // the fake 2s timers behind it are replaced by a real recorder.
  var micCard = null;
  window.startDictation = function (cardId) {
    micCard = cardId || window.dockTargetId();
    if (!micCard) return;
    window.dockRecordingStart();
    if (typeof window.setIslandMicBadge === 'function') window.setIslandMicBadge(true);
    post('mic:start', { cardId: micCard });
  };
  window.confirmDictation = function () {
    if (!micCard) return;
    window.dockRecordingTranscribing();
    post('mic:stop', { cardId: micCard });
  };
  window.cancelDictation = function () {
    if (!micCard) return;
    post('mic:cancel', { cardId: micCard });
    micCard = null;
    if (typeof window.setIslandMicBadge === 'function') window.setIslandMicBadge(false);
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
        if (item.name) {
          var sess = (window.TMS_DATA.sessions || []).find(function (x) { return x.id === cardId; });
          if (sess) sess.name = item.name;
          var nameEl = document.querySelector('.term-card[data-id="' + cardId + '"] .card-name');
          if (nameEl) nameEl.value = item.name;
        }
        mountTerm(cardId);
        post('terminal:attach', Object.assign({ cardId: cardId, sessionId: item.sessionId }, dims(cardId)));
      });
      restoring = false;
      if (typeof window.syncDockTerminal === 'function') window.syncDockTerminal();
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
      if (typeof window.syncDockTerminal === 'function') window.syncDockTerminal();
      post('terminal:attach', Object.assign({ cardId: cardId, sessionId: sessionId }, dims(cardId)));
    },
    /** PTY output. */
    output: function (sessionId, chunk) {
      var cardId = cardOf(sessionId);
      if (!cardId || !terms[cardId]) { (queued[sessionId] = queued[sessionId] || []).push(chunk); return; }
      terms[cardId].term.write(chunk);
      window.updateJumpOrb(cardId, true);
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
    /** Whisper result -> into the bar's input line. */
    dictationResult: function (cardId, text) {
      micCard = null;
      window.dockRecordingEnd(text || '');
      if (typeof window.setIslandMicBadge === 'function') window.setIslandMicBadge(false);
    },
    dictationTranscribing: function () { window.dockRecordingTranscribing(); },
    toast: function (msg) { if (typeof window.toast === 'function') window.toast(msg); },
  };

  // ══ Rückfragen ════════════════════════════════════════════════════════════
  // Approve already reaches the PTY through the card's sim (Enter). Deny did
  // not: the mockup only printed a line, because its simulator had nothing to
  // cancel. A real prompt needs a real Escape.
  var promptCard = null;
  var origHandlePrompt = window.handlePrompt;
  window.handlePrompt = function (id, data) {
    promptCard = id;
    origHandlePrompt(id, data);
  };
  var origResolvePrompt = window.resolvePrompt;
  window.resolvePrompt = function (approved) {
    var id = promptCard;
    promptCard = null;
    origResolvePrompt(approved);
    if (!approved && id) window.__tmsInput(id, '\x1b');
  };

  // ══ Umbenennen ════════════════════════════════════════════════════════════
  // The mockup renamed in memory only. Its own blur handler runs first, so by
  // the time ours does, session[field] already holds the new value.
  var origWireEditable = window.wireEditableField;
  window.wireEditableField = function (input, field, session) {
    origWireEditable(input, field, session);
    if (!input) return;
    // Cards are rebuilt (and therefore re-wired) on every view switch, so blur
    // fires constantly. Only a value that actually changed is a rename.
    var last = session[field];
    input.addEventListener('blur', function () {
      if (session[field] === last) return;
      last = session[field];
      post('terminal:rename', { cardId: session.id, field: field, value: last });
    });
  };

  // ══ Einstellungen ═════════════════════════════════════════════════════════
  // Without this there is no way out of Season 2 from inside Season 2.
  var origRenderSettings = window.renderSettings;
  window.renderSettings = function () {
    origRenderSettings();
    var body = document.getElementById('settingsBody');
    if (!body) return;
    var group = document.createElement('div');
    group.className = 'settings-group glass';
    group.innerHTML =
      '<div class="settings-group__title">Oberfläche</div>' +
      '<div class="settings-row is-tap" id="s2ToClassic">' +
        '<span class="settings-row__label">Klassische Oberfläche<small>Season 2 verlassen — jederzeit wieder umschaltbar</small></span>' +
        '<span class="settings-row__value">Wechseln</span></div>' +
      '<div class="settings-row is-tap" id="s2ClassicSettings">' +
        '<span class="settings-row__label">Klassische Einstellungen<small>Sicherheit, Benachrichtigungen, Cloud-Tokens, Manager …</small></span>' +
        '<span class="settings-row__value">Öffnen</span></div>';
    body.appendChild(group);
    group.querySelector('#s2ToClassic').addEventListener('click', function () {
      post('nav:classic', { screen: 'classic' });
    });
    group.querySelector('#s2ClassicSettings').addEventListener('click', function () {
      post('nav:classic', { screen: 'settings' });
    });
  };
  window.renderSettings();

  // ══ Update-Banner ═════════════════════════════════════════════════════════
  var origRenderUpdateBanner = window.renderUpdateBanner;
  window.renderUpdateBanner = function (host) {
    var u = window.TMS_DATA.update || {};
    if (!u.latest || u.latest === u.current) return; // nothing to offer
    origRenderUpdateBanner(host);
    var cta = host.querySelector('.update-pill .cta');
    if (cta) {
      var fresh = cta.cloneNode(true);
      cta.parentNode.replaceChild(fresh, cta);
      fresh.addEventListener('click', function () { post('update:install', {}); });
    }
  };

  // ══ React Native → WebView (Server, Update, Auto-Approve) ═════════════════
  window.TMSBridge.setServers = function (servers) {
    window.TMS_DATA.servers = servers;
    if (typeof window.renderServers === 'function') window.renderServers();
    if (typeof window.renderSettings === 'function') window.renderSettings();
  };
  window.TMSBridge.setUpdate = function (update) {
    window.TMS_DATA.update = update;
    if (typeof window.renderServers === 'function') window.renderServers();
  };
  /** React Native owns Auto-Approve; make the card's toggle agree with it. */
  window.TMSBridge.setAutoApprove = function (cardId, on) {
    var toggle = document.querySelector('.term-card[data-id="' + cardId + '"] .auto-toggle');
    if (!toggle) return;
    var isOn = toggle.classList.contains('is-on');
    if (isOn !== !!on && typeof window.toggleCardAutoApprove === 'function') {
      window.toggleCardAutoApprove(cardId);
    }
  };

  document.addEventListener('pointerdown', function (e) {
    if (e.target.closest && e.target.closest('.term-card')) {
      setTimeout(function () {
        if (typeof window.syncDockTerminal === 'function') window.syncDockTerminal();
      }, 0);
    }
  }, true);

  post('bridge:ready', {});
})();
