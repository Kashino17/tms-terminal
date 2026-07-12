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

  // ══ Manager ═══════════════════════════════════════════════════════════════
  // The mockup wired its input at boot, so its listeners are already attached.
  // Replacing the nodes is the only way to drop them without touching source.
  function rewire(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    var clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    return clone;
  }
  var managerInput = rewire('managerTextInput');
  var managerMic = rewire('managerMicBtn');
  if (managerInput) {
    managerInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var text = managerInput.value.trim();
      if (!text) return;
      managerInput.value = '';
      post('manager:send', { text: text });
    });
  }
  if (managerMic) {
    managerMic.addEventListener('click', function () {
      if (managerMic.classList.contains('is-recording')) { post('manager:mic', { stop: true }); return; }
      managerMic.classList.add('is-recording');
      post('manager:mic', { stop: false });
    });
  }

  // ══ Cloud ═════════════════════════════════════════════════════════════════
  var origOpenCloud = window.openCloudDetail;
  window.openCloudDetail = function (id, tab) {
    origOpenCloud(id, tab);
    post('cloud:open', { projectId: id });
  };

  // ══ Browser ═══════════════════════════════════════════════════════════════
  // The mockup's fake page renderer is replaced by a real, native incognito
  // WebView that React Native lays over #browserContent. Its chrome — tabs,
  // address bar, progress, sheets — stays exactly as designed.
  var origResolvePage = window.resolveBrowserPage;
  window.resolveBrowserPage = function (raw) {
    var input = String(raw || '').trim();
    if (!input) return origResolvePage(input); // keep the mockup's new-tab page
    return { kind: 'native', url: input, display: input };
  };
  var origNewTabHtml = window.browserNewTabHtml;
  window.renderBrowserPageHtml = function (page) {
    return page.kind === 'newtab' ? origNewTabHtml() : '<div class="native-page"></div>';
  };
  window.browserTabGlyph = function (tab) {
    var page = tab.history[tab.historyIndex];
    return !page || page.kind === 'newtab' ? '+' : '⊕';
  };

  function browserVisible() {
    var screen = document.querySelector('[data-screen="browser"]');
    return !!screen && !screen.hidden;
  }
  function syncNativeBrowser() {
    var tab = window.activeBrowserTab && window.activeBrowserTab();
    var host = document.getElementById('browserContent');
    if (!tab || !host) { post('browser:sync', { visible: false }); return; }
    var page = tab.history[tab.historyIndex] || {};
    var r = host.getBoundingClientRect();
    post('browser:sync', {
      visible: browserVisible() && page.kind !== 'newtab',
      tabId: tab.id,
      url: page.kind === 'newtab' ? '' : page.url || '',
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    });
  }
  var origRenderTab = window.renderBrowserActiveTab;
  window.renderBrowserActiveTab = function (opts) {
    origRenderTab(opts);
    syncNativeBrowser();
  };
  var origCloseTab = window.closeBrowserTab;
  window.closeBrowserTab = function (id) {
    origCloseTab(id);
    post('browser:closeTab', { tabId: id });
    syncNativeBrowser();
  };
  window.browserReload = function () { post('browser:reload', {}); };

  // Screen changes drive the overlay: it must never float over Terminals.
  var origShow = window.show;
  window.show = function (name) {
    origShow(name);
    post('nav:screen', { screen: name });
    if (name === 'browser') setTimeout(syncNativeBrowser, 80);
    else post('browser:sync', { visible: false });
  };
  window.addEventListener('resize', function () { if (browserVisible()) syncNativeBrowser(); });

  // ══ React Native → WebView (Manager / Cloud / Browser) ═════════════════════
  window.TMSBridge.setManager = function (messages) {
    window.TMS_DATA.manager.messages = messages;
    if (managerMic) managerMic.classList.remove('is-recording');
    if (typeof window.renderManagerChat === 'function') window.renderManagerChat();
  };
  window.TMSBridge.setCloud = function (projects) {
    window.TMS_DATA.cloudProjects = projects;
    if (typeof window.renderCloudGroups === 'function') window.renderCloudGroups();
  };
  window.TMSBridge.setCloudDetail = function (projectId, detail) {
    var p = (window.TMS_DATA.cloudProjects || []).find(function (x) { return x.id === projectId; });
    if (!p) return;
    if (detail.env) p.env = detail.env;
    if (detail.logs) p.logs = detail.logs;
    if (detail.deploys) p.deploys = detail.deploys;
    if (typeof window.renderCloudDetail === 'function') window.renderCloudDetail();
  };
  /** The native page reported its real title — put it in the chrome. */
  window.TMSBridge.browserTitle = function (tabId, title, url) {
    var tab = (window.activeBrowserTab && window.activeBrowserTab()) || null;
    if (!tab || tab.id !== tabId) return;
    var page = tab.history[tab.historyIndex];
    if (!page || page.kind === 'newtab') return;
    if (title) page.display = title;
    if (url) page.url = url;
    if (typeof window.syncBrowserChrome === 'function') window.syncBrowserChrome();
  };
  window.TMSBridge.browserSync = syncNativeBrowser;

  // ══ Werkzeug-Sheets ═══════════════════════════════════════════════════════
  // Each sheet renders straight out of TMS_DATA[key], so the whole job is to
  // put real data there and to make the taps do real work.
  var origOpenTool = window.openToolSheet;
  var openTool = null;
  window.openToolSheet = function (id) {
    openTool = id;
    origOpenTool(id);
    post('tool:open', { tool: id });
  };
  var origCloseSheet = window.closeSheet;
  window.closeSheet = function (el) {
    origCloseSheet(el);
    openTool = null;
  };

  function activeCardId() {
    var el = document.querySelector('.term-card.is-active[data-id], .term-card[data-id]');
    return el ? el.getAttribute('data-id') : null;
  }

  // Dateien — the mockup showed a flat list; a real tree needs to be walkable.
  window.__tmsCwd = '~';
  window.buildFilesSheet = function () {
    var files = window.TMS_DATA.files || [];
    var rows = files.map(function (f) {
      if (f.type === 'dir') {
        return '<button class="tool-row is-tap" data-cd="' + escapeHtml(f.name) + '">' +
          '<span class="tool-row__icon">▸</span><span class="tool-row__name">' + escapeHtml(f.name) + '</span>' +
          '<span class="tool-row__meta"></span></button>';
      }
      return '<div class="tool-row"><span class="tool-row__icon">·</span>' +
        '<span class="tool-row__name">' + escapeHtml(f.name) + '</span>' +
        '<span class="tool-row__meta">' + escapeHtml(f.size || '') + '</span></div>';
    }).join('');
    var up = '<button class="tool-row is-tap" data-cd="..">' +
      '<span class="tool-row__icon">▴</span><span class="tool-row__name mono-text">' + escapeHtml(window.__tmsCwd) + '</span>' +
      '<span class="tool-row__meta">aufwärts</span></button>';
    return {
      html: '<div class="tool-list">' + up + rows + '</div>',
      wire: function () {
        document.querySelectorAll('#toolSheetBody [data-cd]').forEach(function (btn) {
          btn.addEventListener('click', function () { post('files:cd', { name: btn.dataset.cd }); });
        });
      },
    };
  };

  // Snippets — tapping one writes it into the active terminal for real.
  window.buildSnippetsSheet = function () {
    var list = window.TMS_DATA.snippets || [];
    var html = '<div class="tool-list">' + list.map(function (s) {
      return '<button class="tool-row is-tap" data-snippet="' + escapeHtml(s.id) + '">' +
        '<span class="tool-row__name">' + escapeHtml(s.label) + '</span>' +
        '<span class="tool-row__meta mono-text">' + escapeHtml(s.cmd) + '</span></button>';
    }).join('') + '</div>';
    return {
      html: html,
      wire: function () {
        document.querySelectorAll('#toolSheetBody [data-snippet]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var s = (window.TMS_DATA.snippets || []).find(function (x) { return x.id === btn.dataset.snippet; });
            if (!s) return;
            var card = activeCardId();
            if (card) { window.__tmsInput(card, s.cmd); toast('In Terminal eingefügt'); }
            else toast('Kein aktives Terminal');
          });
        });
      },
    };
  };

  // SQL — the real store holds the statements detected in the terminal output,
  // not a query with a result grid; show those and let one be copied.
  window.buildSqlSheet = function () {
    var rows = window.TMS_DATA.sql && window.TMS_DATA.sql.statements || [];
    if (!rows.length) return { html: '<div class="tool-empty">Keine SQL-Statements erkannt.</div>' };
    var html = '<div class="tool-list">' + rows.map(function (r, i) {
      return '<button class="tool-row is-tap" data-sql="' + i + '">' +
        '<span class="tool-row__name mono-text">' + escapeHtml(r.sql) + '</span>' +
        '<span class="tool-row__meta">' + escapeHtml(r.time || '') + '</span></button>';
    }).join('') + '</div>';
    return {
      html: html,
      wire: function () {
        document.querySelectorAll('#toolSheetBody [data-sql]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var r = rows[Number(btn.dataset.sql)];
            if (r) { post('clipboard:write', { text: r.sql }); }
          });
        });
      },
    };
  };

  // Ports — the mockup had an on/off switch, but the real thing is a list of
  // saved forwards with nothing to switch. Tapping one opens it in the browser,
  // which is what a forwarded port is actually for.
  window.buildPortsSheet = function () {
    var list = window.TMS_DATA.ports || [];
    if (!list.length) return { html: '<div class="tool-empty">Keine Port-Weiterleitungen gespeichert.</div>' };
    var html = '<div class="tool-list">' + list.map(function (p) {
      return '<button class="tool-row is-tap" data-port="' + escapeHtml(String(p.port)) + '">' +
        '<span class="tool-row__name mono-text">:' + escapeHtml(String(p.port)) + '</span>' +
        '<span class="tool-row__meta">' + escapeHtml(p.service || '') + ' · öffnen</span></button>';
    }).join('') + '</div>';
    return {
      html: html,
      wire: function () {
        document.querySelectorAll('#toolSheetBody [data-port]').forEach(function (row) {
          row.addEventListener('click', function () { post('ports:open', { port: row.dataset.port }); });
        });
      },
    };
  };

  var origBuildWatchers = window.buildWatchersSheet;
  window.buildWatchersSheet = function () {
    var built = origBuildWatchers();
    return {
      html: built.html,
      wire: function () {
        document.querySelectorAll('#toolSheetBody [data-watcher]').forEach(function (row) {
          var input = row.querySelector('input[type="checkbox"]');
          if (input) input.addEventListener('change', function () {
            post('watcher:toggle', { id: row.dataset.watcher, on: input.checked });
          });
        });
      },
    };
  };

  // ══ Notizen & Todos pro Terminal ══════════════════════════════════════════
  // Every mutation (add, toggle, delete) re-renders the sheet body, so a single
  // hook there catches all of them — no need to override each handler.
  var origOpenSessionSheet = window.openSessionSheet;
  var sheetCardId = null;
  window.openSessionSheet = function (id) {
    sheetCardId = id;
    origOpenSessionSheet(id);
  };
  var origRenderSessionBody = window.renderSessionSheetBody;
  window.renderSessionSheetBody = function () {
    origRenderSessionBody();
    if (!sheetCardId) return;
    var s = (window.TMS_DATA.sessions || []).find(function (x) { return x.id === sheetCardId; });
    if (s) post('notes:sync', { cardId: sheetCardId, notes: s.notes || [], todos: s.todos || [] });
  };

  // ══ React Native → WebView (Sheets) ═══════════════════════════════════════
  window.TMSBridge.setTool = function (key, data, cwd) {
    window.TMS_DATA[key] = data;
    if (cwd) window.__tmsCwd = cwd;
    if (openTool === key) origOpenTool(key); // rebuild the open sheet in place
  };
  window.TMSBridge.setPrayer = function (times) {
    window.TMS_DATA.prayerTimes = times;
    if (typeof window.renderPrayerList === 'function') window.renderPrayerList();
    if (typeof window.updateLatencyDisplay === 'function') window.updateLatencyDisplay();
  };
  /** Jump to the Browser screen and load a URL (used by the Ports sheet). */
  window.TMSBridge.openBrowser = function (url) {
    var wrap = document.getElementById('toolSheetWrap');
    if (wrap && typeof window.closeSheet === 'function') window.closeSheet(wrap);
    window.show('browser');
    if (typeof window.browserNavigate === 'function') window.browserNavigate(url);
  };
  window.TMSBridge.setNotes = function (cardId, notes, todos) {
    var s = (window.TMS_DATA.sessions || []).find(function (x) { return x.id === cardId; });
    if (!s) return;
    s.notes = notes;
    s.todos = todos;
    if (sheetCardId === cardId) origRenderSessionBody();
  };

  post('bridge:ready', {});
})();
