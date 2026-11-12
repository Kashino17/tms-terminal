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

  // Reine Funktion in einer eigenen Datei, damit mobile/scripts/prayer-bridge.test.mjs
  // sie ohne Fenster pruefen kann. Hier nur der Aufruf — die Datei wird von
  // build-season2-html.js vor bridge.js eingefuegt.
  // Das Mockup selbst kennt kein postMessage — es ist eine reine HTML-Seite. Fuer
  // die Stellen, die jetzt wirklich etwas bestellen (Gebetsruf-Schalter), geben
  // wir ihm unsere post() als window.__tmsPost. Sonst waeren diese Knoepfe im
  // Mockup stumm und in der App stumm — zweimal schlecht statt einmal gut.
  window.__tmsPost = post;

  var normalizePrayerPayload = window.__tmsNormalizePrayer;
  if (typeof normalizePrayerPayload !== 'function') {
    // Ohne die Datei waere nur die alte Liste moeglich — nicht stumm werden.
    normalizePrayerPayload = function (times) {
      return { times: Array.isArray(times) ? times : [], meta: null };
    };
  }

  var terms = {};        // cardId -> { term, fit, element, host }
  var bound = {};        // cardId -> sessionId | 'pending'
  var byCard = {};       // cardId -> sessionId (resolved only)
  var queued = {};       // sessionId -> [chunk] — arrived before its card existed
  var restoring = false;

  function cardOf(sessionId) {
    for (var id in byCard) if (byCard[id] === sessionId) return id;
    return null;
  }

  // Mehrere Geräte: React Native soll wissen, welches Terminal vorne ist —
  // Dateien und Fingerabdruck-Bestätigung gehören zu dessen Gerät. Nur echte
  // Wechsel werden gemeldet.
  var lastActiveSid = null;
  window.__tmsReportActive = function () {
    if (typeof window.__tmsReportFocus === 'function') window.__tmsReportFocus();
    var st = window.__tmsState;
    var cardId = st && st.order ? st.order[st.activeIndex] : null;
    var sid = (cardId && byCard[cardId]) || null;
    // Eine Karte ohne Sitzung (gerade angelegt) meldet sich erst nach bindSession.
    if (!sid || sid === lastActiveSid) return;
    lastActiveSid = sid;
    post('term:active', { sessionId: sid });
  };

  // ── Aufmerksamkeit: welches Terminal ist wirklich zu sehen? ───────────────
  // Der Server sendet danach: das Terminal vorne sofort, verdeckte gebündelt
  // (server/src/websocket/output.pacer.ts). Gemeldet wird nur ein echter
  // Wechsel. Die Regel selbst steht in attention.core.mjs (getestet).
  var lastFocus, lastLatency;
  /** Ist gerade irgendwo ein Ping-Wert zu sehen? Nur dann lohnt es, alle 3 s
   *  zu messen — sonst prüft die App die Leitung nur noch selten. */
  var LATENCY_SPOTS = '#statusLatencyLabel, .ds-dev__ms, .rail-dev__meta, #remotePill .rp-dev small, section[data-screen="servers"]:not([hidden])';
  function latencyVisible() {
    var els = document.querySelectorAll(LATENCY_SPOTS);
    for (var i = 0; i < els.length; i++) if (els[i].offsetParent !== null) return true;
    return false;
  }
  window.__tmsReportFocus = function () {
    var st = window.__tmsState;
    if (!st || typeof window.__tmsFocusOf !== 'function') return;
    var screen = document.querySelector('section[data-screen="terminals"]');
    var compact = document.body.classList.contains('compact-terminal');
    var cardId = compact && typeof window.dockTargetId === 'function' ? window.dockTargetId() : st.order[st.activeIndex];
    var focus = window.__tmsFocusOf({
      terminalsVisible: !!screen && !screen.hidden,
      remote: document.body.classList.contains('remote-focus'),
      overview: !!st.overviewOpen,
      listView: st.terminalView === 'list',
      compact: compact,
      activeSession: (cardId && byCard[cardId]) || null,
    });
    var latency = latencyVisible();
    if (focus === lastFocus && latency === lastLatency) return;
    lastFocus = focus;
    lastLatency = latency;
    post('term:focus', { focus: focus, latency: latency });
  };
  // Ansichtswechsel (Liste/Stapel, Übersicht, Sheets) laufen über viele kleine
  // Funktionen der Seite — statt jede einzeln zu umwickeln, wird nach jeder
  // Berührung einmal nachgesehen. Gesendet wird ohnehin nur bei Änderung.
  var focusT = 0;
  function focusSoon() { clearTimeout(focusT); focusT = setTimeout(window.__tmsReportFocus, 350); }
  document.addEventListener('click', focusSoon, true);
  document.addEventListener('pointerup', focusSoon, true);

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
  /**
   * Die Spaltenzahl MUSS aus der Schrift kommen, in der wir wirklich zeichnen —
   * nicht aus der, die xterm intern misst. Sonst passt eine Zeile, die der
   * Emulator für voll hält, im DOM nicht mehr in die Karte: die CSS bricht sie
   * ein ZWEITES Mal um. Genau das hat den Inhalt zerrissen und verschoben.
   */
  function measureCell(pre) {
    // Höhe an einer ECHTEN .term-line messen: die Font-Box des Spans ist nur
    // ~15px hoch, die gezeichnete Zeile aber line-height (1.6em + 2px) ≈ 22,8px.
    // Mit der Font-Box als Zeilenhöhe bekam die PTY zu viele rows — die TUI malte
    // mehr Zeilen, als in die Karte passen, und der obere Rand (Tab-Leiste!) war
    // dauerhaft abgeschnitten.
    var probe = document.createElement('span');
    probe.className = 'term-line';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;';
    var text = document.createElement('span');
    text.className = 'term-line__text';
    text.textContent = new Array(101).join('0');
    probe.appendChild(text);
    pre.appendChild(probe);
    var r = text.getBoundingClientRect();
    var h = probe.getBoundingClientRect().height;
    probe.remove();
    // getBoundingClientRect zählt CSS-Transforms mit, clientWidth (Basis der
    // Spaltenrechnung in measureFit) nicht. layoutStack() verkleinert jede
    // Karte nach Abstand zur aktiven (92,5 / 85 / 77,5 %) — ungekürzt bekam
    // jede Session eine Breite je nach Stapel-Position (39/42/46/50 Spalten),
    // und jeder Wisch löste SIGWINCH + Umbruch-Salat aus. Skalierung rausrechnen.
    var hr = pre.getBoundingClientRect();
    var sx = pre.offsetWidth ? hr.width / pre.offsetWidth : 1;
    var sy = pre.offsetHeight ? hr.height / pre.offsetHeight : 1;
    return { w: r.width / 100 / (sx || 1), h: h / (sy || 1) };
  }

  /** Karte vermessen → gewünschte Spalten/Zeilen. null, wenn (noch) ohne Größe. */
  function measureFit(t) {
    var host = t.host;
    if (!host || !host.clientWidth || !host.clientHeight) return null;
    var cell = measureCell(host);
    if (!cell.w || !cell.h) return null;
    var cs = getComputedStyle(host);
    var innerW = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var innerH = host.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    cell = fitFont(host, innerW, cell);
    return {
      cols: Math.max(20, Math.min(FIXED_COLS, Math.floor(innerW / cell.w))),
      rows: Math.max(2, Math.floor(innerH / cell.h)),
    };
  }

  // FESTE BREITE: Jede Sitzung hat FIXED_COLS Spalten — Außendisplay,
  // aufgeklappt, Split-Screen. Nicht die Spaltenzahl folgt der Kartenbreite,
  // sondern die Schrift. Jeder Breitenwechsel war sonst ein SIGWINCH, und
  // Claudes bereits (hart) umgebrochener Verlauf wurde in der neuen Breite
  // zerhackt. Ab FONT_MAX bleibt rechts Platz frei; unter FONT_MIN lieber
  // weniger Spalten als unlesbare Schrift.
  var FIXED_COLS = 50, FONT_MIN = 10, FONT_MAX = 20;
  function fitFont(host, innerW, cell) {
    var cur = parseFloat(getComputedStyle(host).fontSize) || 13;
    var want = Math.floor(Math.max(FONT_MIN, Math.min(FONT_MAX, cur * innerW / (FIXED_COLS * cell.w))) * 10) / 10;
    for (var i = 0; i < 6; i++) {
      if (Math.abs(want - cur) >= 0.05) { host.style.fontSize = want + 'px'; cur = want; cell = measureCell(host); }
      if (Math.floor(innerW / cell.w) >= FIXED_COLS || want <= FONT_MIN) break;
      // Glyphen-Rundung: echte Zeichenbreite minimal größer als gerechnet.
      want = Math.max(FONT_MIN, Math.round((want - 0.1) * 10) / 10);
    }
    return cell;
  }

  // A keyboard / split divider changes BOTH dimensions. Commit one stable
  // size after the animation, rather than keeping a permanently oversized TUI
  // or sending a SIGWINCH for every intermediate animation frame.
  var SIZE_SETTLE_MS = 350;
  // ZEILEN-RATSCHE (v1.123.9 zurück; v1.123.7 hatte sie entfernt): Bei gleicher
  // Breite wachsen die Zeilen nur, sie schrumpfen nie. Die Tastatur drückte die
  // Karte auf ~13 Zeilen; Claudes Live-Bereich (Eingabe, Fortschritt, Todos) ist
  // oft höher. Ink erreicht dann beim Neumalen die oberen Zeilen nicht mehr und
  // jeder Frame bleibt als Kopie im Verlauf stehen (E2E: 1 → 14 Claude-Köpfe nach
  // 13 Tastatur-Runden). Ist die Karte kleiner, scrollt die Anzeige — renderTerm
  // hält das Ende (Eingabefeld) sichtbar. Neue Breite setzt die Ratsche zurück.
  function ratchetFit(t, fit) {
    if (!fit || t.pinCols === undefined || fit.cols !== t.pinCols) return fit;
    // Wechsel zwischen virtueller und echter Höhe (Vollbild-Programm an/aus)
    // ist gewollt in BEIDE Richtungen — dort greift die Ratsche nicht.
    if (t.pinReal !== wantsRealRows(t)) return fit;
    return fit.rows < t.pinRows ? { cols: fit.cols, rows: t.pinRows } : fit;
  }
  // VIRTUELLE HÖHE (2026-11-05): Die PTY bekommt VIRTUAL_ROWS Zeilen, die Karte
  // zeigt davon nur den Inhalt bis zum Ende (renderTerm schneidet leere Zeilen
  // unter dem Inhalt ab). Grund: Claude zeigt in Bestätigungs-Boxen ganze
  // Befehle — bei 50 Spalten oft 100+ Zeilen hoch. Ist die Box höher als das
  // Terminal, kann Claude ihren weggerollten Teil nie mehr löschen: Box-Reste
  // und doppelte Absätze bleiben im Verlauf (E2E: 31 Zeilen → Reste, 200 → keine).
  // Vollbild-Programme (vim, OpenCode, …) brauchen dagegen die echte Höhe.
  var VIRTUAL_ROWS = 200;
  function wantsRealRows(t) {
    return !t.virt || t.term.buffer.active.type === 'alternate' || !!t.forceMouse || runsFullscreenTui(t);
  }
  // Windows: ConPTY gibt den alternativen Bildschirm nicht weiter — vim, less &
  // Co. sind dort nur am Prozessnamen erkennbar (Server meldet ihn per
  // terminal:process). Unter macOS/Linux greift schon der Puffer-Wechsel oben.
  var FULLSCREEN_TUIS = { vim: 1, nvim: 1, vi: 1, view: 1, less: 1, more: 1, man: 1, htop: 1, btop: 1, top: 1,
    nano: 1, micro: 1, hx: 1, emacs: 1, lazygit: 1, tig: 1, mc: 1, ranger: 1, yazi: 1, k9s: 1, opencode: 1 };
  function runsFullscreenTui(t) {
    if (typeof procBySession === 'undefined' || typeof byCard === 'undefined' || !t.cardId) return false;
    var n = String(procBySession[byCard[t.cardId]] || '').toLowerCase().split(/[\\/]/).pop().replace(/\.exe$/, '');
    return !!FULLSCREEN_TUIS[n];
  }
  function virtualFit(t, fit) {
    if (!fit || wantsRealRows(t) || fit.rows >= VIRTUAL_ROWS) return fit;
    return { cols: fit.cols, rows: VIRTUAL_ROWS };
  }
  function computeFit(t) { return ratchetFit(t, virtualFit(t, measureFit(t))); }
  function applyTerminalSize(cardId, size) {
    var t = terms[cardId];
    if (!t) return;
    if (t.term.cols !== size.cols || t.term.rows !== size.rows) {
      t.term.resize(size.cols, size.rows);
      invalidateRowCache(cardId);
    }
    t.pinCols = size.cols;
    t.pinRows = size.rows;
    t.pinReal = wantsRealRows(t);
  }
  function settleTerminalSize(cardId, size) {
    var t = terms[cardId];
    if (!t) return;
    var key = size.cols + 'x' + size.rows;
    if (t.sizeWant === key && t.sizeTimer) return;
    t.sizeWant = key;
    clearTimeout(t.sizeTimer);
    t.sizeTimer = setTimeout(function () {
      t.sizeTimer = null;
      if (terms[cardId] !== t) return; // closed/replaced while waiting
      var fit = computeFit(t);
      if (!fit) return;
      if (fit.cols === t.pinCols && fit.rows === t.pinRows) return;
      if (fit.cols + 'x' + fit.rows !== t.sizeWant) {
        settleTerminalSize(cardId, fit);
        return;
      }
      try { applyTerminalSize(cardId, fit); } catch (_) { return; }
      renderTerm(cardId);
    }, SIZE_SETTLE_MS);
  }
  function fitNow(cardId) {
    var t = terms[cardId];
    if (!t) return false;
    var fit = computeFit(t);
    if (!fit) return false;
    if (t.pinCols === undefined) {
      try { applyTerminalSize(cardId, fit); } catch (_) { return false; }
    } else if (fit.cols !== t.pinCols || fit.rows !== t.pinRows) {
      settleTerminalSize(cardId, fit);
    } else {
      clearTimeout(t.sizeTimer);
      t.sizeTimer = null;
    }
    return true;
  }

  function fitSoon(cardId) {
    var t = terms[cardId];
    if (!t) return;
    clearTimeout(t.fitTimer);
    t.fitTimer = setTimeout(function () {
      if (!fitNow(cardId)) {
        if ((t.fitTries = (t.fitTries || 0) + 1) < 40) fitSoon(cardId);
        return;
      }
      t.fitTries = 0;
      renderTerm(cardId);
    }, 60);
  }

  /** Alle Emulatoren leben unsichtbar hier — sie rendern nichts mehr selbst.
   *  WICHTIG: komplett aus dem sichtbaren Bereich schieben. Im Body-Fluss lagen
   *  sie HINTER halbtransparenten Glasflächen — der Browser hat sie bei jedem
   *  write() mitgemalt und obendrein die backdrop-filter darüber invalidiert.
   *  Offscreen wird nichts gerastert; Layout, Vermessung und der Tastatur-Fokus
   *  der xterm-Textarea funktionieren dort unverändert (display:none täte das
   *  nicht: kaputte Glyphen-Messung, kein Fokus). */
  var emuHost = document.createElement('div');
  emuHost.id = 'tmsEmulators';
  emuHost.style.cssText = 'position:fixed;top:0;left:-4000px;';
  document.body.appendChild(emuHost);

  // Input growth, key accessories and reading focus can change a terminal
  // without firing a window resize. Observe its actual content box as well.
  var terminalHostObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.target.isConnected) { terminalHostObserver.unobserve(entry.target); return; }
      var id = entry.target.dataset.cardId;
      if (id && terms[id]) fitSoon(id);
    });
  });
  function observeTerminalHost(t, host) {
    if (t.host && t.host !== host && terminalHostObserver) terminalHostObserver.unobserve(t.host);
    t.host = host;
    if (terminalHostObserver) terminalHostObserver.observe(host);
    if (!host.__tmsFollowWired) {
      host.__tmsFollowWired = true;
      host.addEventListener('scroll', function () {
        var current = terms[host.dataset.cardId];
        if (current && current.host === host) current.followTail = host.scrollHeight - host.scrollTop - host.clientHeight < 30;
      }, { passive: true });
    }
  }
  function mountTerm(cardId) {
    var host = document.querySelector('.card-body[data-card-id="' + cardId + '"]');
    if (!host) return;
    var t = terms[cardId];
    if (t) { observeTerminalHost(t, host); fitSoon(cardId); renderTerm(cardId); return; }

    var box = document.createElement('div');
    box.style.cssText = 'width:600px;height:400px;';
    emuHost.appendChild(box);

    var term = new window.Terminal({
      fontFamily: 'monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: false,
    });
    term.open(box);
    // xterms eigener Renderer malt in dieses unsichtbare Kästchen — für nichts:
    // die Karte baut renderTerm selbst. Seine Pause außerhalb des Bildschirms
    // griff in der echten Seite nicht (gemessen: alle versteckten Emulatoren
    // malten jede Zeile, bei 10 Terminals der größte Rechenposten). Fest pausieren.
    // Gemessen (10 Terminals, Dauerausgabe): 80 000 Neuaufbauten in 70 s kamen
    // über xterms Auswahl-Logik (SelectionService → handleSelectionChanged →
    // DomRenderer.renderRows), am Pausen-Schalter vorbei. Darum den Renderer
    // selbst stilllegen, nicht nur den Takt.
    var rsvc = term._core && term._core._renderService;
    if (rsvc && typeof rsvc._renderRows === 'function') {
      rsvc._renderRows = function () {};
      rsvc.handleSelectionChanged = function () {};
      var rdr = rsvc._renderer && rsvc._renderer.value;
      if (rdr && typeof rdr.renderRows === 'function') {
        rdr.renderRows = function () {};
        rdr.handleSelectionChanged = function () {};
      }
      if (typeof rsvc._handleIntersectionChange === 'function') {
        rsvc._handleIntersectionChange = function () { rsvc._isPaused = true; };
        rsvc._isPaused = true;
      }
    }
    // Dasselbe für xterms restliche Bildschirm-Verwaltung: Scrollfläche
    // (Viewport) und Auswahl (SelectionService) forderten bei jeder Ausgabe
    // je ein Bild an und schrieben Stile in das unsichtbare Kästchen —
    // gemessen ~33 Anforderungen/s bei einem 10-Hz-Spinner. Gescrollt und
    // ausgewählt wird in der Karte (renderTerm), nie hier.
    try {
      var vp = term._core && term._core.viewport;
      if (vp && typeof vp._refresh === 'function') vp._refresh = function () {};
      var selSvc = term._core && term._core._selectionService;
      if (selSvc && typeof selSvc.refresh === 'function') selSvc.refresh = function () {};
    } catch (e) { /* andere xterm-Version: dann eben wie bisher */ }

    // Der Emulator ist unsichtbar, aber sein Textfeld ist die Tastatur-Anbindung:
    // ein Tipp ins Terminal fokussiert es. Androids Wortvorschlag komponierte hier
    // ganze Wörter vor und schickte beim Leerzeichen Zeichensalat — ein Feld im
    // URL-Modus bekommt weder Autokorrektur noch Vorschläge.
    var ta = term.textarea;
    if (ta) {
      ta.setAttribute('inputmode', 'url');
      ta.setAttribute('autocomplete', 'off');
      ta.setAttribute('autocorrect', 'off');
      ta.setAttribute('autocapitalize', 'none');
      ta.setAttribute('spellcheck', 'false');
    }

    term.onData(function (d) { window.__tmsInput(cardId, d); });
    term.onResize(function (sz) { queueResize(cardId, sz.cols, sz.rows); });

    terms[cardId] = { term: term, box: box, host: host, scrollTotal: 0, cardId: cardId, followTail: true };
    // Welche Zeilen hat die letzte Ausgabe verändert? xterm kennt das intern
    // (dieselbe Meldung treibt sonst seinen eigenen Renderer, der hier
    // unsichtbar pausiert). renderTerm liest damit nur geänderte Zeilen neu
    // statt den ganzen lebenden Bildschirm — Voraussetzung für die virtuelle
    // Höhe. Fehlt die Meldung (andere xterm-Version), bleibt alles beim Alten.
    var ih = term._core && term._core._inputHandler;
    if (ih && typeof ih.onRequestRefreshRows === 'function') {
      try {
        ih.onRequestRefreshRows(function (s0, e0) {
          var tt = terms[cardId];
          if (!tt || tt.term !== term) return;
          var b = term.buffer.active;
          // Global-ID einer Bildschirmzeile = Scroll-Zähler + Zeile. Gemeldet
          // wird am Ende eines Schreibvorgangs; was davor schon k Zeilen
          // hochgerollt ist, lag damals k Zeilen tiefer → Bereich nach oben weiten.
          var k = tt.dScroll === undefined ? 0 : tt.scrollTotal - tt.dScroll;
          tt.dScroll = tt.scrollTotal;
          var g0 = tt.scrollTotal - b.baseY + b.viewportY;
          var lo = g0 + Math.min(s0, e0) - k, hi = g0 + Math.max(s0, e0);
          if (tt.dLo === undefined || lo < tt.dLo) tt.dLo = lo;
          if (tt.dHi === undefined || hi > tt.dHi) tt.dHi = hi;
        });
        terms[cardId].virt = true;
      } catch (_) { /* ohne Meldung: echte Höhe, Voll-Lesen wie bisher */ }
    }
    // Vollbild-Programm startet/endet: Höhe umschalten (virtuell ↔ echt).
    term.buffer.onBufferChange(function () {
      invalidateRowCache(cardId);
      fitNow(cardId);
    });
    observeTerminalHost(terms[cardId], host);
    // Kam der Prozessname schon vor dem Mount (Reattach-Rennen), hier nachziehen.
    var sid0 = byCard[cardId];
    if (sid0) {
      terms[cardId].forceMouse = isMouseTui(procBySession[sid0]);
      forceMouseOn(terms[cardId]);
    }
    // Monotoner Scroll-Zähler: die Basis der GLOBALEN Zeilen-IDs des Renderers.
    // Absolute Puffer-Indizes allein taugen nicht als Adresse — sobald der
    // xterm-Ringpuffer voll ist (baseY sättigt am Scrollback-Limit), verschiebt
    // JEDE neue Zeile alle Inhalte unter ihren alten Indizes. Der eingefrorene
    // Zeilen-Cache zeigte ab da alte Zeilen an falschen Stellen — die
    // "Dopplungen" in jeder langen Claude-Session.
    term.onScroll(function () { var tt = terms[cardId]; if (tt) tt.scrollTotal++; });
    fitSoon(cardId);
    flush(cardId);
    renderTerm(cardId);
  }

  // ── Vom Emulator-Puffer in die DOM-Form des Mockups ────────────────────────
  var PALETTE = ['#1e2126','#e05561','#8cc265','#d18f52','#4aa5f0','#c162de','#42b3c2','#d7dae0',
                 '#6b7280','#ff6b74','#a5e075','#f0a45d','#66b8ff','#d67bef','#5fd0dd','#f0f2f6'];
  var MAX_ROWS = 800;   // so viel Scrollback halten wir als DOM vor
  var WIN_SLACK = 200;  // so weit darf das DOM-Fenster überwachsen, bevor beschnitten wird
  // URLs zuerst; Pfade nur, wenn davor kein / : ~ oder Wortzeichen steht — sonst
  // wird die zweite Hälfte einer umgebrochenen URL als eigener "Pfad" erkannt.

  function xterm256(c) {
    if (c < 16) return PALETTE[c];
    if (c < 232) {
      var i = c - 16, r = Math.floor(i / 36), g2 = Math.floor((i % 36) / 6), b2 = i % 6;
      var v = function (x) { return x ? 55 + x * 40 : 0; };
      return 'rgb(' + v(r) + ',' + v(g2) + ',' + v(b2) + ')';
    }
    var l = 8 + (c - 232) * 10;
    return 'rgb(' + l + ',' + l + ',' + l + ')';
  }
  function colorOf(cell, isFg) {
    if (isFg) {
      if (cell.isFgDefault()) return null;
      if (cell.isFgRGB()) return '#' + ('000000' + cell.getFgColor().toString(16)).slice(-6);
      return xterm256(cell.getFgColor());
    }
    if (cell.isBgDefault()) return null;
    if (cell.isBgRGB()) return '#' + ('000000' + cell.getBgColor().toString(16)).slice(-6);
    return xterm256(cell.getBgColor());
  }

  /** Effektiver Zell-Hintergrund; inverse Zellen tauschen Vorder- und Hintergrund. */
  function cellBg(cell) {
    var fg = colorOf(cell, true), bg = colorOf(cell, false);
    // Muss zu runStyle() passen, sonst weicht das Zeilenband vom Lauf ab.
    if (cell.isInverse()) return fg || '#f0f2f6';
    return bg;
  }

  /**
   * Eine Pufferzeile -> zusammengefasste Abschnitte + der Hintergrund, den ALLE
   * Zellen der Zeile teilen (oder null).
   *
   * Warum das GANZE Zeilenband zählt: eine TUI wie opencode malt ihre Panels
   * als lückenlose Hintergrundfarbe über die komplette Breite. Ein Inline-Span
   * deckt aber nur die Font-Box ab (ca. 15px bei 13px Schrift), nicht die
   * Zeilenhöhe (1,6 → 20,8px) — dadurch blieben zwischen den Zeilen Streifen in
   * Kartenfarbe stehen. Einen einheitlichen Zeilenhintergrund malt deshalb der
   * Block .term-line selbst (volle Zeilenhöhe, volle Breite).
   */
  function rowRuns(line) {
    var runs = [], cur = null, uniformBg;
    for (var i = 0; i < line.length; i++) {
      var cell = line.getCell(i);
      if (!cell) continue;
      var ch = cell.getChars() || ' ';
      var cbg = cellBg(cell);
      if (uniformBg === undefined) uniformBg = cbg;
      else if (uniformBg !== cbg) uniformBg = null;
      var st = (colorOf(cell, true) || '') + '|' + (colorOf(cell, false) || '') + '|' +
               (cell.isBold() ? 'b' : '') + (cell.isDim() ? 'd' : '') +
               (cell.isItalic() ? 'i' : '') + (cell.isUnderline() ? 'u' : '') + (cell.isInverse() ? 'v' : '');
      if (!cur || cur.st !== st) { cur = { st: st, text: '', cell: cell }; runs.push(cur); }
      cur.text += ch;
    }
    return { runs: runs, bg: uniformBg === undefined ? null : uniformBg };
  }

  function runStyle(cell, lineBg) {
    var fg = colorOf(cell, true), bg = colorOf(cell, false), css = '';
    if (cell.isInverse()) { var tmp = fg; fg = bg || '#1e2126'; bg = tmp || '#f0f2f6'; }
    if (fg) css += 'color:' + fg + ';';
    if (bg && bg !== lineBg) css += 'background:' + bg + ';';
    if (cell.isBold()) css += 'font-weight:700;';
    if (cell.isDim()) css += 'opacity:.62;';
    if (cell.isItalic()) css += 'font-style:italic;';
    if (cell.isUnderline()) css += 'text-decoration:underline;';
    return css;
  }

  /**
   * Baut die Zeilen als .term-line > .term-line__text — exakt die Form, für die
   * die Selektion, die Griffe und die Kopieren-Bubble des Mockups gebaut sind.
   * Umgebrochene Links werden über die LOGISCHE Zeile erkannt, damit ein Tipp
   * die ganze URL liefert statt der Hälfte bis zum Zeilenumbruch.
   */
  /** Baut den Inhalt einer .term-line (den inneren __text-Span) für EINE Zeile.
   *  Gibt zusätzlich den einheitlichen Zeilenhintergrund zurück; der gehört auf
   *  den .term-line-Block (der Patcher schreibt ihn dorthin). */
  function buildRowInner(line, linkRanges) {
    if (!line) return { inner: '<span class="term-line__text"></span>', bg: null };
    var rr = rowRuns(line);
    var runs = rr.runs, lineBg = rr.bg;
    var col = 0, html = '';
    for (var q = 0; q < runs.length; q++) {
      var run = runs[q], style = runStyle(run.cell, lineBg), txt = run.text;
      var runBg = cellBg(run.cell);
      // Ein abweichender Hintergrund innerhalb der Zeile kann nicht am Block
      // liegen — er bekommt .term-run (inline-block, volle Zeilenhöhe).
      var runClass = runBg && runBg !== lineBg ? ' class="term-run"' : '';
      // Den Abschnitt an Link-Grenzen zerlegen, damit die URL anklickbar wird.
      var pos = 0;
      while (pos < txt.length) {
        var abs = col + pos;
        var hit = null;
        for (var li = 0; li < linkRanges.length; li++) {
          if (abs >= linkRanges[li].from && abs < linkRanges[li].to) { hit = linkRanges[li]; break; }
        }
        var stop = txt.length;
        for (var lj = 0; lj < linkRanges.length; lj++) {
          var bnd = hit ? linkRanges[lj].to : linkRanges[lj].from;
          if (bnd > abs && bnd - col < stop) stop = bnd - col;
        }
        var piece = txt.slice(pos, stop);
        if (piece) {
          var inner = '<span' + runClass + ' style="' + style + '">' + escapeHtml(piece) + '</span>';
          html += hit
            ? '<span class="wrapped-link" data-url="' + escapeHtml(hit.url) +
              '" data-short="' + escapeHtml(hit.url.slice(-10)) + '" role="link">' + inner + '</span>'
            : inner;
        }
        pos = stop;
      }
      col += txt.length;
    }
    return { inner: '<span class="term-line__text">' + html + '</span>', bg: lineBg };
  }

  function rowWrapper(k, inner, bg) {
    // data-b markiert Bridge-eigene Zeilen: daran erkennt der Patcher fremde
    // Rebuilds (renderCardLines des Mockups) und fällt auf den Vollaufbau zurück.
    // Der Zeilenhintergrund (TUI-Panel) sitzt am Block, damit er die volle
    // Zeilenhöhe deckt — nicht am Inline-Span (der nur die Font-Box malt).
    return '<span class="term-line" data-b="1" data-i="' + k + '"' +
      (bg ? ' data-bg="' + bg + '" style="background:' + bg + '"' : '') +
      '>' + inner + '</span>';
  }

  function invalidateRowCache(cardId) {
    var t = terms[cardId];
    if (!t) return;
    t.rc = null; t.rcMin = 0; t.dom = null; t.domStart = undefined; t.domLen = 0;
    t.cEndG = undefined; t.rEnd = undefined; t.dScroll = undefined;
    t.winStart = undefined; // Reflow verschiebt die absoluten Indizes — Fenster neu setzen
    // Globale IDs neu eichen: nach Resize-Reflow (und term.clear/reset) stimmt
    // das Verhältnis Scroll-Zähler ↔ baseY nicht mehr; ab hier gilt wieder
    // "keine getrimmten Zeilen" als Ausgangslage.
    t.scrollTotal = t.term.buffer.active.baseY;
  }

  function renderTerm(cardId) {
    var t = terms[cardId];
    var pre = t && t.host;
    if (!t || !pre || !pre.isConnected) return;
    // Mitten im Griff-Drag nichts neu bauen — der Output wird nachgeholt.
    if (typeof window.__tmsDragging === 'function' && window.__tmsDragging(cardId)) {
      scheduleRender(cardId);
      return;
    }
    // Unsichtbare Karten werden nicht gemalt — der xterm-Puffer läuft für jede
    // Session ungebremst weiter, nur der teure innerHTML-Rebuild unter dem
    // Backdrop-Blur ruht. Das Mockup zeichnet über flushHiddenCards() nach,
    // sobald die Karte wieder zu sehen ist.
    if (typeof window.__tmsCardVisible === 'function' && !window.__tmsCardVisible(cardId)) {
      (window.__tmsPendingHidden || (window.__tmsPendingHidden = {}))[cardId] = 1;
      return;
    }
    if (window.__tmsPendingHidden) delete window.__tmsPendingHidden[cardId];

    var buf = t.term.buffer.active;
    var baseY = buf.baseY;
    // ── Globale Zeilen-IDs ────────────────────────────────────────────────
    // Adresse einer Zeile ist NICHT ihr Puffer-Index (der verschiebt sich,
    // sobald der Ringpuffer voll ist oder CSI 3J die Historie leert), sondern
    // eine monotone globale Nummer: pufferIndex + trimmed. `trimmed` = wie
    // viele Zeilen der Ringpuffer schon oben verworfen hat.
    if (t.scrollTotal === undefined || t.scrollTotal < baseY) t.scrollTotal = baseY;
    var trimmed = t.scrollTotal - baseY;
    var end = trimmed + baseY + t.term.rows;           // global: eine Zeile hinter der letzten
    // Virtuelle Höhe: Leere Zeilen UNTER dem Inhalt gehören nicht auf die Karte
    // (sonst stünde Claudes Eingabefeld über 170 Leerzeilen). Gesucht wird nur
    // ab dem bekannten Inhaltsende bzw. der tiefsten geänderten Zeile.
    var dLo = t.dLo, dHi = t.dHi;
    t.dLo = t.dHi = undefined;
    var now = Date.now();
    // Sicherheitsnetz: höchstens einmal pro Sekunde den ganzen Bildschirm neu
    // lesen — sollte xterm je eine Änderung nicht melden, heilt sie so von selbst.
    var fullPass = !t.virt || !t.rc || !(t.fullAt > now - 1000);
    if (fullPass) t.fullAt = now;
    if (t.virt && buf.type !== 'alternate') {
      var vpTop = trimmed + baseY;
      var hiG = (fullPass || t.cEndG === undefined) ? end
        : Math.min(end, Math.max(t.cEndG, dHi === undefined ? 0 : dHi + 1));
      var floorG = vpTop + buf.cursorY + 1;
      while (hiG > floorG) {
        var ln = buf.getLine(hiG - 1 - trimmed);
        if (ln && ln.translateToString(true).length) break;
        hiG--;
      }
      t.cEndG = hiG;
      end = hiG;
    }

    // ── Klebriges Fenster ─────────────────────────────────────────────────
    // Ein mitwanderndes Fenster (immer die letzten MAX_ROWS) verschiebt bei JEDER
    // neuen Zeile alle Indizes — und data-i ist die Adresse, unter der die
    // Selektion ihre Zeilen findet. Es müssten also pro Ausgabe-Tick alle 800
    // Attribute neu geschrieben werden. Stattdessen bleibt der Anfang stehen und
    // das Fenster wächst; erst wenn es MAX_ROWS + SLACK überschreitet, wird auf
    // MAX_ROWS zurückgeschnitten. Neunummeriert wird damit einmal pro SLACK
    // Zeilen statt einmal pro Zeile.
    var start = t.winStart;
    if (start === undefined || start > end) start = Math.max(0, end - MAX_ROWS);
    if (end - start > MAX_ROWS + WIN_SLACK) start = Math.max(0, end - MAX_ROWS);
    // Zeilen, die der Ringpuffer schon verworfen hat (oder die ein CSI 3J des
    // Servers gelöscht hat), sind nicht mehr lesbar — das Fenster rückt nach.
    if (start < trimmed) start = trimmed;
    t.winStart = start;

    // ── Zeilen-Cache über ABSOLUTE Pufferindizes ──────────────────────────
    // Alles unterhalb von baseY ist aus dem Viewport gescrollte Historie und
    // ändert sich nie wieder — nur der lebende Viewport (~Terminalhöhe) wird
    // pro Durchlauf neu aus dem Puffer gelesen. Vorher wurden hier bei jeder
    // Ausgabe alle 800 Zeilen zellenweise neu gebaut: der größte CPU-Fresser
    // des ganzen Layouts.
    var rc = t.rc || (t.rc = {}, t.rcMin = start, t.rc);
    // Unter das Inhaltsende gefallene Zeilen vergessen: wurden sie dort
    // geändert, las sie niemand — der alte Stand darf später nicht zurückkommen.
    if (t.rEnd > end) for (var gz = end; gz < t.rEnd; gz++) delete rc[gz];
    t.rEnd = end;
    if (start > (t.rcMin || 0)) {
      for (var d = t.rcMin || 0; d < start; d++) delete rc[d];
      t.rcMin = start;
    }

    // Eine am Viewport-Rand umgebrochene logische Zeile reicht in die Historie
    // hinein — ihren Anfang mit auffrischen, damit eine wachsende URL ihre
    // Link-Spanne über die Umbruchgrenze bekommt.
    var liveFrom = Math.min(trimmed + baseY, end);
    while (liveFrom > start) {
      var probeC = rc[liveFrom];
      var probeW = probeC ? probeC.wrapped
        : (function () { var l = buf.getLine(liveFrom - trimmed); return !!(l && l.isWrapped); })();
      if (!probeW) break;
      liveFrom--;
    }

    var total = end - start;
    var rows = new Array(total);
    for (var i = start; i < end; i++) {
      var k = i - start;
      var c = rc[i];
      // Ein Cache-Eintrag ist nur dann endgültig, wenn er gelesen wurde, als die
      // Zeile BEREITS Historie war (unter baseY). Zeilen, die beim Lesen noch im
      // lebenden Viewport standen, ändern sich danach ja weiter — sie einfach
      // wiederzuverwenden, sobald sie nach unten rausgescrollt sind, fror den
      // Stand von damals ein: leere Historie ("Grenze nach oben") und alte
      // Inhalte an neuen Zeilennummern (die Dopplungen/Verschiebungen).
      if (c && c.frozen && i < liveFrom) { rows[k] = c; continue; }
      // Lebende Zeile, die die letzte Ausgabe nicht berührt hat: unverändert.
      if (c && !fullPass && !(dLo !== undefined && i >= dLo && i <= dHi)) { rows[k] = c; continue; }
      var line = buf.getLine(i - trimmed);
      rows[k] = rc[i] = {
        text: line ? line.translateToString(true) : '',
        wrapped: !!(line && line.isWrapped),
        inner: null,           // wird unten gebaut, sobald die Links bekannt sind
        bg: null,              // einheitlicher Zeilenhintergrund (TUI-Panel)
        sig: null,
        frozen: i - trimmed < baseY, // fertig gescrollt = ändert sich nie wieder
      };
    }

    // Logische Zeilen für die Link-Erkennung: Terminal-Umbrüche UND die harten
    // Umbrüche, die Claude Code selbst macht (Zeile bis zum Rand, Fortsetzung
    // eingerückt) — Regel und Tests: stitchRows im Mockup (termText-Block).
    // Jeder Teil eines umgebrochenen Links trägt so die GANZE URL; ein Tipp
    // darauf kopiert sie vollständig, ohne Umbrüche und Einrückung.
    var links = typeof window.stitchLinks === 'function' ? window.stitchLinks(rows, t.term.cols) : {};

    // Inneres HTML nur für Zeilen (neu) bauen, deren Inhalt oder Link-Lage sich
    // geändert hat. Gecachte Historie mit unveränderter Link-Signatur ist fertig.
    for (var r = 0; r < total; r++) {
      var row = rows[r];
      var ranges = links[r] || [];
      var sig = '';
      for (var si = 0; si < ranges.length; si++) sig += ranges[si].from + ':' + ranges[si].to + ':' + ranges[si].url + ';';
      if (row.inner !== null && row.sig === sig) continue;
      var built = buildRowInner(buf.getLine(start + r - trimmed), ranges);
      row.inner = built.inner;
      row.bg = built.bg;
      row.sig = sig;
    }

    var atBottom = t.followTail !== false;

    // ── DOM abgleichen statt neu bauen ────────────────────────────────────
    // Der komplette innerHTML-Tausch hat pro Ausgabe-Tick hunderte KB HTML
    // geparst und die ganze Karte relayoutet. Jetzt: oben rausgescrollte
    // Zeilen entfernen, geänderte ersetzen, neue unten anhängen.
    var lineEls = pre.getElementsByClassName('term-line'); // live
    var dom = t.dom;
    var canPatch = dom && t.domStart !== undefined && start >= t.domStart &&
      lineEls.length === t.domLen &&
      (t.domLen === 0 || (lineEls[0] && lineEls[0].dataset.b === '1'));

    if (!canPatch) {
      var out = new Array(total);
      for (var f = 0; f < total; f++) out[f] = rowWrapper(f, rows[f].inner, rows[f].bg);
      pre.innerHTML = out.join('');
      dom = t.dom = {};
      for (var f2 = 0; f2 < total; f2++) dom[start + f2] = rows[f2].inner;
    } else {
      var dropTop = start - t.domStart;
      for (var d2 = 0; d2 < dropTop && lineEls.length; d2++) {
        delete dom[t.domStart + d2];
        lineEls[0].remove();
      }
      var keep = Math.min(lineEls.length, total);
      for (var p = 0; p < keep; p++) {
        var absI = start + p;
        var el = lineEls[p];
        if (dom[absI] !== rows[p].inner) {
          el.innerHTML = rows[p].inner;
          dom[absI] = rows[p].inner;
        }
        // Der Panel-Hintergrund liegt am Block (siehe rowWrapper) und muss
        // deshalb separat nachgezogen werden — er ändert sich auch dann, wenn
        // der Zeileninhalt gleich bleibt (TUI malt ihren Hintergrund um).
        var wantBg = rows[p].bg || '';
        if ((el.dataset.bg || '') !== wantBg) {
          if (wantBg) { el.style.background = wantBg; el.dataset.bg = wantBg; }
          else { el.style.background = ''; delete el.dataset.bg; }
        }
      }
      // Sollte das DOM je LÄNGER sein als das Fenster (kommt regulär nicht
      // vor), überzählige Zeilen am Ende entfernen.
      while (lineEls.length > total) { delete dom[start + lineEls.length - 1]; lineEls[lineEls.length - 1].remove(); }
      if (total > keep) {
        var addHtml = '';
        for (var n = keep; n < total; n++) {
          addHtml += rowWrapper(n, rows[n].inner, rows[n].bg);
          dom[start + n] = rows[n].inner;
        }
        if (keep > 0) lineEls[keep - 1].insertAdjacentHTML('afterend', addHtml);
        else pre.insertAdjacentHTML('afterbegin', addHtml);
      }
      // Nach einem Fenster-Shift stimmen die relativen Indizes nicht mehr —
      // data-i ist die Adresse der Selektion, also nachziehen (reine
      // Attribut-Schreiber, kein Layout).
      if (dropTop > 0) {
        for (var ri2 = 0; ri2 < lineEls.length; ri2++) {
          if (lineEls[ri2].dataset.i !== String(ri2)) lineEls[ri2].dataset.i = ri2;
        }
      }
    }
    t.domStart = start;
    t.domLen = lineEls.length;

    var cs = window.__tmsCardState && window.__tmsCardState[cardId];
    if (cs) {
      pre.classList.toggle('selection-mode', !!cs.selectionMode);
      cs.lines = rows.map(function (x) { return x.text; }); // Kopieren/Selektion lesen daraus
      cs.rowsWrapped = rows.map(function (x) { return x.wrapped; });
      cs.cols = t.term.cols;
      cs._renderedLen = cs.lines.length;
      if (cs.selection && cs.selection.end >= total) cs.selection = null;
      if (cs.selection && cs.selection.sc === undefined) {
        pre.querySelectorAll('.term-line').forEach(function (l, i) {
          l.classList.toggle('is-selected', i >= cs.selection.start && i <= cs.selection.end);
        });
      } else {
        // Beim Patchen überleben die Elemente — eine erloschene Auswahl muss
        // ihre Markierung explizit verlieren (der alte Voll-Rebuild tat das
        // als Nebenwirkung).
        var stale = pre.querySelectorAll('.term-line.is-selected');
        for (var sv = 0; sv < stale.length; sv++) stale[sv].classList.remove('is-selected');
      }
    }
    // Wer gerade markiert, will lesen — nicht ans Ende springen.
    var selecting = cs && (cs.selectionMode || cs.selection);
    if (atBottom && !selecting) pre.scrollTop = pre.scrollHeight;
    // Das Neuzeichnen ersetzt den Karteninhalt — Griffe und Kopieren-Bubble sind
    // Kinder davon und wären sonst bei jeder Ausgabe wieder weg.
    if (cs && cs.selection && typeof window.positionHandlesAndBubble === 'function') {
      window.positionHandlesAndBubble(cardId);
    }
    if (typeof window.updateJumpOrb === 'function') window.updateJumpOrb(cardId, !atBottom);
  }

  // Gedrosselt: bei Dauerausgabe nicht öfter als alle 60 ms neu zeichnen —
  // aber die ERSTE Ausgabe nach einer Pause sofort. Vorher wartete jede Ausgabe
  // pauschal 60 ms (gemessen: Tastendruck → sichtbar 85 ms bei 2 ms Netz).
  var RENDER_GAP_MS = 60;
  var renderTimers = {}, lastRenderAt = {};
  function scheduleRender(cardId) {
    if (renderTimers[cardId]) return;
    var wait = Math.max(0, RENDER_GAP_MS - (Date.now() - (lastRenderAt[cardId] || 0)));
    renderTimers[cardId] = setTimeout(function () {
      renderTimers[cardId] = null;
      lastRenderAt[cardId] = Date.now();
      renderTerm(cardId);
    }, wait);
  }
  // Der Demo-Ticker des Mockups würfelt die Latenz — am echten Server aus.
  if (typeof window.__tmsStopLatencyDemo === 'function') window.__tmsStopLatencyDemo();

  window.__tmsRenderTerm = renderTerm;
  /** Karten mit echter PTY rendert die Bridge (farbig, inkrementell). Das
   *  Mockup fragt hier, bevor sein renderCardLines() den Karteninhalt mit
   *  einem Klartext-Rebuild überschreibt — der zerstörte nebenbei den
   *  DOM-Abgleich des Patchers. */
  window.__tmsBridgeRenders = function (cardId) {
    if (!terms[cardId] || !byCard[cardId]) return false;
    renderTerm(cardId);
    return true;
  };

  // Both dimensions already settle before term.resize(). Forward that stable
  // size together so the PTY does not lag another animation behind xterm.
  var resizeTimers = {}, lastDims = {};
  function queueResize(cardId, cols, rows) {
    if (!cols || !rows) return;
    clearTimeout(resizeTimers[cardId]);
    resizeTimers[cardId] = setTimeout(function () {
      var sid = byCard[cardId];
      if (!sid) return;
      // Während der Ruhephase weitergewachsen? Dann zählt der jetzige Stand.
      var t = terms[cardId];
      var c = (t && t.term.cols) || cols;
      var r = (t && t.term.rows) || rows;
      var key = c + 'x' + r;
      if (lastDims[sid] === key) return;
      lastDims[sid] = key;
      post('terminal:resize', { sessionId: sid, cols: c, rows: r });
    }, 16);
  }

  /** Vorschau für Übersicht und Rail — aus dem echten Puffer. */
  window.__tmsPreview = function (cardId, n) {
    var t = terms[cardId];
    if (!t) return '';
    var buf = t.term.buffer.active, out = [];
    for (var i = buf.baseY + buf.cursorY; i >= 0 && out.length < n; i--) {
      var line = buf.getLine(i);
      if (!line) continue;
      var text = line.translateToString(true).replace(/\s+$/, '');
      if (text) out.unshift(escapeHtml(text));
    }
    return out.join('<br>');
  };
  var previewTimers = {};
  function refreshPreview(cardId) {
    clearTimeout(previewTimers[cardId]);
    previewTimers[cardId] = setTimeout(function () {
      if (window.__tmsAppInactive) return; // niemand schaut hin (natives AppState-Signal)
      // offsetParent === null ⇒ ein display:none-Vorfahr (z. B. Rail auf dem
      // Frontdisplay): dann weder Puffer durchlaufen noch DOM schreiben.
      var tile = document.querySelector('.overview-tile[data-id="' + cardId + '"] .overview-tile__body');
      if (tile && tile.offsetParent) tile.innerHTML = window.__tmsPreview(cardId, 5);
      var rail = document.querySelector('.rail-item[data-id="' + cardId + '"] .rail-item__preview');
      if (rail && rail.offsetParent) rail.innerHTML = window.__tmsPreview(cardId, 2);
    }, 350);
  }

  function flush(cardId) {
    var sid = byCard[cardId];
    var t = terms[cardId];
    if (!sid || !t || !queued[sid]) return;
    queued[sid].forEach(function (c) { writeTerm(t, c); });
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

  /** Anhängen erst mit ECHTEN Maßen. Mit erfundenen 80×24 schickte der Server
   *  seinen Rückstand (bzw. jetzt sein Snapshot) in falscher Breite, und der
   *  direkt folgende Resize ließ alles noch einmal umbrechen — der klassische
   *  Start "mit Zeilensalat ab der ersten Sekunde". Warten, bis die Karte
   *  messbar ist (max ~2,4 s), dann anhängen; danach nur noch echte Resizes. */
  function attachSized(cardId, sessionId, tries) {
    if (!fitNow(cardId) && (tries || 0) < 40) {
      setTimeout(function () { attachSized(cardId, sessionId, (tries || 0) + 1); }, 60);
      return;
    }
    var d = dims(cardId);
    lastDims[sessionId] = d.cols + 'x' + d.rows;
    post('terminal:attach', { cardId: cardId, sessionId: sessionId, cols: d.cols, rows: d.rows, fresh: isFresh(cardId) });
  }
  /** Leeres Seiten-Terminal (Kaltstart, neu gebaute Seite)? Dann muss der Server
   *  das Vollbild MIT Verlauf schicken — bei gleicher Breite und ohne verpasste
   *  Ausgabe schickte er sonst nichts, und nach einem App-Neustart blieb die
   *  Karte leer bis auf das, was Claude selbst neu malte. */
  function isFresh(cardId) {
    var t = terms[cardId];
    return !(t && t.gotData);
  }

  // Cards appear/disappear whenever the mockup rebuilds its workspace. Follow
  // the DOM instead of duplicating that logic: an unseen card means a terminal
  // we still have to create server-side.
  var timer = null;
  var createTries = {}; // cardId -> Anläufe, die Karte vor dem Anlegen zu vermessen
  function syncTerms() {
    // Keep the first scheduled scan: frequent UI updates must not postpone
    // terminal creation indefinitely.
    if (timer !== null) return;
    timer = setTimeout(function () {
      timer = null;
      document.querySelectorAll('.card-body[data-card-id]').forEach(function (host) {
        var cardId = host.getAttribute('data-card-id');
        // The cloud log viewer reuses the card-body markup but is a read-only
        // line view — creating a PTY for it put a Mac shell into the Logs tab.
        if (cardId.indexOf('cloud-') === 0) return;
        mountTerm(cardId); // mounts, or re-homes an existing terminal
        if (!restoring && !(cardId in bound)) {
          // Nie mit erfundenen 80×24 anlegen: Die Shell malt ihre ersten Zeilen
          // für DIESE Breite, und der nachgereichte Resize auf die echten ~46
          // Spalten ließ sie gleich als Erstes umbrechen und neu malen. Warten,
          // bis die Karte messbar ist (max ~2,4 s), erst dann anlegen.
          if (!fitNow(cardId)) {
            createTries[cardId] = (createTries[cardId] || 0) + 1;
            if (createTries[cardId] < 40) { setTimeout(syncTerms, 60); return; }
          }
          delete createTries[cardId];
          bound[cardId] = 'pending';
          var tc = terms[cardId];
          var sessName = (window.TMS_DATA.sessions || []).find(function (x) { return x.id === cardId; });
          post('terminal:create', {
            cardId: cardId,
            cols: (tc && tc.term.cols) || 80,
            rows: (tc && tc.term.rows) || 24,
            name: sessName ? sessName.name : undefined,
            serverId: (sessName && sessName.server) || undefined,
          });
        }
      });
      Object.keys(terms).forEach(function (cardId) {
        if (!document.querySelector('.card-body[data-card-id="' + cardId + '"]')) {
          try { terms[cardId].term.dispose(); terms[cardId].box.remove(); } catch (e) {}
          delete terms[cardId];
        }
      });
    }, 50);
  }
  // Only added/removed card bodies require a scan. Header, status and preview
  // updates are not card changes; following those repeatedly remeasures every
  // terminal and can starve a newly added card while other sessions are busy.
  var cardBodySelector = '.card-body[data-card-id]';
  function containsCardBody(node) {
    return node.nodeType === 1 &&
      (node.matches(cardBodySelector) || node.querySelector(cardBodySelector));
  }
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var t = records[i].target;
      if (t.nodeType === 1 && t.closest &&
          (t.closest('.card-body[data-card-id]') || t.closest('#tmsEmulators'))) continue;
      var nodes = Array.prototype.concat.call(
        Array.prototype.slice.call(records[i].addedNodes),
        Array.prototype.slice.call(records[i].removedNodes)
      );
      for (var j = 0; j < nodes.length; j++) {
        if (containsCardBody(nodes[j])) { syncTerms(); return; }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  function fitAllTerminals() { Object.keys(terms).forEach(fitSoon); }
  window.addEventListener('resize', fitAllTerminals);
  window.addEventListener('tms:terminal-layout', fitAllTerminals);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitAllTerminals);

  // ── Replace the mockup's demo plumbing ────────────────────────────────────
  // Not a no-op: xterm owns the pixels, but the mockup still expects this to
  // (re)establish the per-line elements its selection UI works on.
  // Das Mockup zeichnet die Karte neu -> wir liefern die Zeilen aus dem Emulator.
  var origRenderCardLines = window.renderCardLines;
  window.renderCardLines = function (id) {
    // Cloud log viewers are no terminals — keep the mockup's own renderer.
    if (String(id).indexOf('cloud-') === 0) { origRenderCardLines(id); return; }
    renderTerm(id);
  };
  window.initLiveSession = function () { /* no simulator — output comes from the PTY */ };
  window.startQuestionScript = function () {};
  window.scheduleQuestionScript = function () {};
  window.showReplay = function () {};
  window.replaySession = function () {};
  window.startLatencyTicker = function () { /* React Native drives the real RTT */ };

  // ── Auswahl-Griffe ────────────────────────────────────────────────────────
  // Das Original suchte die Zielzeile mit elementFromPoint — unter dem Finger
  // liegt aber der GRIFF selbst, also fand es meistens nichts und der Drag tat
  // nichts. Hier wird die Zeile aus der Fingerposition BERECHNET (Zeilenhöhe ist
  // bekannt), am Rand wird nachgescrollt, und solange gezogen wird, pausiert das
  // Neuzeichnen — sonst risse laufender Output den Griff aus der Hand.
  var handleDragCard = null;
  window.__tmsDragging = function (cardId) { return handleDragCard === cardId; };
  window.startHandleDrag = function (e, cardId, kind) {
    e.stopPropagation();
    e.preventDefault();
    var handle = e.currentTarget;
    var pre = document.querySelector('.card-body[data-card-id="' + cardId + '"]');
    var cs = window.__tmsCardState && window.__tmsCardState[cardId];
    if (!pre || !cs || !cs.selection) return;
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    handleDragCard = cardId;
    var probe = pre.querySelector('.term-line');
    var lineH = probe ? probe.getBoundingClientRect().height : 20;
    var padTop = parseFloat(getComputedStyle(pre).paddingTop) || 0;

    function apply(ev) {
      var base = pre.getBoundingClientRect();
      var lines = pre.querySelectorAll('.term-line');
      var total = lines.length;
      // Der Griff haengt UNTER der Zeile (Stiel nach oben) — gemeint ist die Zeile
      // ueber dem Finger, nicht die, auf der er liegt.
      var idx = Math.floor((ev.clientY - lineH * 0.9 - base.top - padTop + pre.scrollTop) / lineH);
      idx = Math.max(0, Math.min(total - 1, idx));
      var col = colAt(pre, lines[idx], ev.clientX, 'round');
      var sel = cs.selection;
      if (sel.sc === undefined) { sel.sc = 0; sel.ec = lineText(lines[sel.end]).length; }
      // Anfang bleibt vor dem Ende und umgekehrt — kein Ueberkreuzen.
      if (kind === 'start') {
        if (idx > sel.end || (idx === sel.end && col > sel.ec)) { idx = sel.end; col = sel.ec; }
        sel.start = idx; sel.sc = col;
      } else {
        if (idx < sel.start || (idx === sel.start && col < sel.sc)) { idx = sel.start; col = sel.sc; }
        sel.end = idx; sel.ec = col;
      }
      window.positionHandlesAndBubble(cardId);
      // Am Rand weiterziehen scrollt nach — sonst endete die Auswahl am Sichtfeld.
      if (ev.clientY < base.top + 28) pre.scrollTop -= lineH;
      else if (ev.clientY > base.bottom - 28) pre.scrollTop += lineH;
    }
    function end(ev) {
      handleDragCard = null;
      try { handle.releasePointerCapture(ev.pointerId); } catch (err) {}
      handle.removeEventListener('pointermove', apply);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      scheduleRender(cardId); // aufgestauten Output nachzeichnen
    }
    handle.addEventListener('pointermove', apply);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  window.sendTerminalCommand = function (id, cmd) {
    if (cmd && cmd.trim()) window.__tmsInput(id, cmd.trim() + '\r');
  };
  window.sendCtrlC = function (id) {
    window.__tmsInput(id, '\x03');
    if (typeof window.toast === 'function') window.toast('^C gesendet');
  };
  window.handleTermKey = function (key, id) {
    // TUIs wie Claudes Auswahlmenü schalten den Application-Cursor-Modus ein
    // (DECCKM) — dort erwartet die Anwendung ESC O A statt ESC [ A. Ein echtes
    // Terminal übersetzt das automatisch; unser Emulator kennt den Modus, also
    // fragen wir ihn. Mit stur ESC [ A kamen die Pfeile im Menü nie an.
    var t = terms[id];
    var app = !!(t && t.term.modes && t.term.modes.applicationCursorKeysMode);
    var seq = {
      ctrlc: '\x03', esc: '\x1b', tab: '\t',
      // Shift+Tab ist kein eigenes Zeichen, sondern CSI Z („back-tab") — damit
      // springt man in Claudes Auswahl und in Formularen rückwärts.
      shifttab: '\x1b[Z',
      // Ein Tap räumt einen ganzen Tippfehler/Pfad weg statt 30x einzeln tippen zu müssen.
      backspace: '\x7f'.repeat(30),
      // Enter/Return fehlte in der Map — der breite Enter-Knopf in der
      // Tastenleiste schickte deshalb NICHTS ans PTY (leeres Feld -> handleTermKey(enter)).
      enter: '\r',
      up:    app ? '\x1bOA' : '\x1b[A',
      down:  app ? '\x1bOB' : '\x1b[B',
      left:  app ? '\x1bOD' : '\x1b[D',
      right: app ? '\x1bOC' : '\x1b[C',
    }[key];
    if (seq) window.__tmsInput(id, seq);
    if (typeof window.flashKeyEcho === 'function') {
      var echo = { ctrlc: '^C', esc: 'Esc', tab: 'Tab', shifttab: '⇧Tab', backspace: '⌫', enter: '⏎', up: '↑', down: '↓', left: '←', right: '→' }[key] || key;
      window.flashKeyEcho(echo);
    }
  };
  window.clearActiveTerminal = function (id) {
    // clear() wirft Historie weg → baseY springt; globale IDs neu eichen.
    if (terms[id]) { terms[id].term.clear(); invalidateRowCache(id); renderTerm(id); }
    if (typeof window.toast === 'function') window.toast('Geleert');
  };
  // scrollTerminalToBottom und updateJumpOrb bleiben die des Mockups: die
  // .card-body ist wieder der echte Scroller.

  // ══ Zeichengenaue Auswahl ═════════════════════════════════════════════════
  // Vorher kannte die Auswahl nur ganze Zeilen ("von Zeile X bis Y"). Jetzt:
  // Zeile + Zeichen fuer Anfang und Ende. Langer Druck markiert das Wort unter
  // dem Finger — auf einem Link den GANZEN Link ueber alle Umbrueche —, die
  // Griffe verschieben zeichenweise, ein Tipp im Markier-Modus nimmt die Zeile.
  // Gemalt wird ueber die Custom-Highlight-API: die Zeilen bleiben unberuehrt,
  // das Neuzeichnen bei laufender Ausgabe stellt die Markierung nur neu her.
  // Textregeln (Umbrueche, Links, Fuellzeichen): termText-Block im Mockup.
  var HAS_HL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
  var selRanges = {};                       // cardId -> Range

  function selPre(cardId) { return document.querySelector('.card-body[data-card-id="' + cardId + '"]'); }
  function lineTextEl(line) { return line && line.querySelector('.term-line__text'); }
  function lineText(line) { var el = lineTextEl(line); return el ? el.textContent : ''; }
  function selRows(cardId, pre) {
    var cs = window.__tmsCardState && window.__tmsCardState[cardId];
    var els = pre.querySelectorAll('.term-line');
    var out = new Array(els.length);
    for (var i = 0; i < els.length; i++) {
      out[i] = { text: lineText(els[i]), wrapped: !!(cs && cs.rowsWrapped && cs.rowsWrapped[i]) };
    }
    return out;
  }
  function selCols(cardId) {
    var cs = window.__tmsCardState && window.__tmsCardState[cardId];
    return cs && cs.cols ? cs.cols : Infinity; // Cloud-Logs: keine harten Umbrueche verbinden
  }
  /** Zeichenbreite (Monospace) aus einer Zeile mit Text messen. */
  function charWidth(pre) {
    var els = pre.querySelectorAll('.term-line__text');
    for (var i = els.length - 1; i >= 0; i--) {
      var n = els[i].textContent.length;
      if (n > 4) return els[i].getBoundingClientRect().width / n;
    }
    return 8;
  }
  /** Fingerposition x → Zeichenspalte in dieser Zeile (round: zwischen zwei Zeichen, floor: das Zeichen). */
  function colAt(pre, line, x, mode) {
    var el = lineTextEl(line);
    if (!el) return 0;
    var len = el.textContent.length;
    var left = el.getBoundingClientRect().left;
    var v = (x - left) / charWidth(pre);
    var c = mode === 'floor' ? Math.floor(v) : Math.round(v);
    return Math.max(0, Math.min(len, c));
  }
  /** Textknoten + Versatz fuer Zeichen c einer Zeile. */
  function domPoint(line, c) {
    var el = lineTextEl(line);
    if (!el) return { node: line, off: 0 };
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), n, left = c, last = null;
    while ((n = w.nextNode())) {
      if (left <= n.length) return { node: n, off: left };
      left -= n.length; last = n;
    }
    return last ? { node: last, off: last.length } : { node: el, off: 0 };
  }
  function caretX(pre, line, pt) {
    var r = document.createRange();
    try { r.setStart(pt.node, pt.off); r.collapse(true); } catch (e) { return 0; }
    var rect = r.getBoundingClientRect();
    var base = pre.getBoundingClientRect();
    var x = rect.width || rect.left ? rect.left : (lineTextEl(line) || line).getBoundingClientRect().left;
    return x - base.left - pre.clientLeft + pre.scrollLeft;
  }
  function paintHighlight() {
    if (!HAS_HL) return;
    var list = Object.keys(selRanges).map(function (k) { return selRanges[k]; }).filter(Boolean);
    if (list.length) CSS.highlights.set('term-sel', new Highlight(list[0]));
    for (var i = 1; i < list.length; i++) CSS.highlights.get('term-sel').add(list[i]);
    if (!list.length) CSS.highlights.delete('term-sel');
  }

  // ── Maus an echte TUIs (opencode, vim, htop …) ────────────────────────────
  // Diese Programme laufen im Alternate Screen und schalten Mouse-Reporting an
  // (?1000/?1002/?1003 zusammen mit ?1006). Dann gibt es KEINEN Terminal-
  // Scrollback: der sichtbare Ausschnitt ist die ganze App. Blaettern und
  // Tippen muessen deshalb als Maus-Event ins PTY — sonst wirkt der Output
  // abgeschnitten (man kommt nie weiter nach oben) und Tabs/Buttons der TUI
  // reagieren nicht. xterm kennt Protokoll und Encoding bereits; wir fragen
  // seinen CoreMouseService, statt SGR-Sequenzen zu raten.
  //
  // Reattach-Falle: der Server schickt nach einem App-Neustart nur einen
  // SerializeAddon-Snapshot. Der enthaelt Text und Farben, aber KEINE DECSET-
  // Modi — opencode schaltet Maus-Reporting nur EINMAL beim Start ein, nie
  // beim Resize. Danach waere areMouseEventsActive fuer immer false und
  // Tipp/Wheel tot. Der Server nennt beim Reattach aber den Vordergrundprozess
  // (terminal:reattached.processName). Fuer bekannte Maus-TUIs stellen wir die
  // Modi lokal wieder her; das PTY sieht davon nichts.
  var procBySession = {};
  var MOUSE_TUIS = { opencode: 1 };
  function isMouseTui(name) {
    // Windows liefert "C:\…\opencode.exe" — Pfad (/ oder \) und .exe abstreifen.
    var n = String(name || '').toLowerCase().split(/[\\/]/).pop().replace(/\.exe$/, '');
    return !!MOUSE_TUIS[n];
  }
  function forceMouseOn(t) {
    if (!t || t.mouseForced || t.forceBlocked) return;
    var sid = byCard[t.cardId];
    if (!isMouseTui(procBySession[sid])) return;
    t.mouseForced = true;
    t.forceMouse = true;
    t.term.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
  }
  /** Live-Ausgabe beobachten: ein explizites Ausschalten der TUI gewinnt. */
  function noteMouseModes(t, chunk) {
    if (!t || !chunk || typeof chunk !== 'string' || chunk.indexOf('\x1b[?100') === -1) return;
    var on = /\x1b\[\?(?:1000|1002|1003|1006)h/.test(chunk);
    var off = /\x1b\[\?(?:1000|1002|1003|1006|1015|1016)l/.test(chunk);
    if (on) t.forceBlocked = false;
    if (off && !on) {
      t.forceMouse = false;
      t.mouseForced = false;
      t.forceBlocked = true;
    }
  }
  function writeTerm(t, chunk, cb) {
    noteMouseModes(t, chunk);
    if (chunk) t.gotData = true;
    t.term.write(chunk, cb);
  }
  function mouseService(t) {
    var core = t && t.term && t.term._core;
    var svc = core && core.coreMouseService;
    if (!svc) return null;
    if (!svc.areMouseEventsActive) forceMouseOn(t);
    return svc.areMouseEventsActive ? svc : null;
  }
  /** Zeile/Spalte unter dem Finger -> 0-basierte Screen-Zelle. */
  function mouseCell(pre, line, x) {
    var t = terms[pre.getAttribute('data-card-id')];
    var svc = mouseService(t);
    if (!svc || !line) return null;
    var rel = Number(line.dataset.i);
    if (!isFinite(rel)) return null;
    var buf = t.term.buffer.active;
    // Gleiche Rechnung wie renderTerm: globale Zeile -> Pufferzeile -> Screen.
    var trimmed = (t.scrollTotal === undefined ? buf.baseY : t.scrollTotal) - buf.baseY;
    var bufLine = (t.domStart || 0) + rel - trimmed;
    var row = bufLine - buf.baseY;
    if (row < 0 || row >= t.term.rows) return null; // Historie ist kein Mausziel
    var col = Math.max(0, Math.min(t.term.cols - 1, colAt(pre, line, x, 'floor')));
    return { svc: svc, col: col, row: row };
  }
  /** xterm-Action: 1 = Druck, 0 = Loslassen, 0/1 + Taste 4 = Wheel hoch/runter. */
  function sendMouse(svc, col, row, button, action) {
    try {
      svc.triggerMouseEvent({ col: col, row: row, button: button, action: action,
        ctrl: false, alt: false, shift: false });
    } catch (e) { /* keine Mouse-API: dann lieber nichts senden als Zeichensalat */ }
  }
  /** Sichtbare Zeile an y — auch wenn die Karte gerade gescrollt ist. */
  function lineAtPoint(pre, y) {
    var lines = pre.querySelectorAll('.term-line');
    if (!lines.length) return null;
    var h = lines[0].getBoundingClientRect().height || 20;
    var top = pre.getBoundingClientRect().top +
      (parseFloat(getComputedStyle(pre).paddingTop) || 0) - pre.scrollTop;
    var idx = Math.floor((y - top) / h);
    return lines[Math.max(0, Math.min(lines.length - 1, idx))];
  }
  function sendWheel(pre, x, y, up, ticks) {
    if (pre.classList.contains('selection-mode')) return false;
    var cell = mouseCell(pre, lineAtPoint(pre, y), x);
    if (!cell) return false;
    for (var i = 0; i < ticks; i++) sendMouse(cell.svc, cell.col, cell.row, 4, up ? 0 : 1);
    return true;
  }
  /** Ein Tipp wird zum Linksklick (Druck + Loslassen) in der TUI. */
  function sendTap(pre, line, x) {
    var cell = mouseCell(pre, line, x);
    if (!cell) return false;
    sendMouse(cell.svc, cell.col, cell.row, 0, 1);
    sendMouse(cell.svc, cell.col, cell.row, 0, 0);
    return true;
  }

  // Nach Langdruck (Auswahl) oder Wischen darf kein Klick mehr folgen.
  var tapBlockUntil = 0;
  var WHEEL_STEP = 20; // px Fingerweg pro Raststufe
  var touchPan = null;

  document.addEventListener('touchstart', function (e) {
    touchPan = null;
    if (e.touches.length !== 1) return;
    var pre = e.target.closest && e.target.closest('.card-body[data-card-id]');
    if (!pre || !mouseService(terms[pre.getAttribute('data-card-id')])) return;
    var p = e.touches[0];
    touchPan = { pre: pre, y0: p.clientY, x0: p.clientX, lastY: p.clientY, axis: 0, acc: 0 };
  }, { capture: true, passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!touchPan || e.touches.length !== 1) return;
    var p = e.touches[0];
    var dy = p.clientY - touchPan.lastY, dx = p.clientX - touchPan.x0;
    if (!touchPan.axis) {
      if (Math.abs(dx) < 5 && Math.abs(p.clientY - touchPan.y0) < 5) return;
      // Waagerecht ist eine Karten-/App-Geste — die nicht abfangen.
      if (Math.abs(dx) > Math.abs(p.clientY - touchPan.y0)) { touchPan = null; return; }
      touchPan.axis = 1;
      dy = 0;
    }
    e.preventDefault(); // kein DOM-Scroll: die TUI blaettert selbst
    touchPan.lastY = p.clientY;
    touchPan.acc += dy;
    var ticks = Math.floor(Math.abs(touchPan.acc) / WHEEL_STEP);
    if (ticks > 0) {
      // Finger nach unten = aeltere Zeilen (Wheel hoch), wie beim nativen Scrollen.
      var up = touchPan.acc > 0;
      // An der START-Stelle bleiben: beim Ziehen wandert der Finger sonst ueber
      // Statusleiste/Eingabefeld, wo ein Wheel-Event nichts mehr bewirkt.
      sendWheel(touchPan.pre, touchPan.x0, touchPan.y0, up, Math.min(ticks, 6));
      touchPan.acc -= (up ? 1 : -1) * ticks * WHEEL_STEP;
      tapBlockUntil = Date.now() + 500;
    }
  }, { capture: true, passive: false });

  function endTouchPan() { touchPan = null; }
  document.addEventListener('touchend', endTouchPan, true);
  document.addEventListener('touchcancel', endTouchPan, true);

  // Mausrad (Desktop/Chromebook) genauso weiterreichen.
  document.addEventListener('wheel', function (e) {
    if (e.ctrlKey) return;
    var pre = e.target.closest && e.target.closest('.card-body[data-card-id]');
    if (!pre) return;
    var ticks = Math.max(1, Math.min(6, Math.round(Math.abs(e.deltaY) / 40) || 1));
    if (sendWheel(pre, e.clientX, e.clientY, e.deltaY < 0, ticks)) e.preventDefault();
  }, { capture: true, passive: false });

  window.positionHandlesAndBubble = function (cardId) {
    var pre = selPre(cardId);
    var cs = window.__tmsCardState && window.__tmsCardState[cardId];
    if (!pre || !cs) return;
    var hs = pre.querySelector('.sel-handle--start');
    var he = pre.querySelector('.sel-handle--end');
    var bubble = pre.querySelector('.copy-bubble');
    var sel = cs.selection;
    var lines = pre.querySelectorAll('.term-line');
    if (!sel || sel.sc === undefined || !lines[sel.start] || !lines[sel.end]) {
      [hs, he, bubble].forEach(function (el) { if (el) el.remove(); });
      delete selRanges[cardId]; paintHighlight();
      return;
    }
    var sl = lines[sel.start], el = lines[sel.end];
    var a = domPoint(sl, sel.sc), b = domPoint(el, sel.ec);
    if (HAS_HL) {
      var range = document.createRange();
      try { range.setStart(a.node, a.off); range.setEnd(b.node, b.off); selRanges[cardId] = range; } catch (e) { delete selRanges[cardId]; }
      paintHighlight();
    } else {
      for (var i = 0; i < lines.length; i++) lines[i].classList.toggle('is-selected', i >= sel.start && i <= sel.end);
    }
    if (!hs) { hs = window.makeHandle('start', cardId); pre.appendChild(hs); }
    if (!he) { he = window.makeHandle('end', cardId); pre.appendChild(he); }
    if (!bubble) { bubble = window.makeBubble(cardId); pre.appendChild(bubble); }
    var x1 = caretX(pre, sl, a), x2 = caretX(pre, el, b);
    hs.style.top = (sl.offsetTop + sl.offsetHeight) + 'px'; hs.style.left = x1 + 'px';
    he.style.top = (el.offsetTop + el.offsetHeight) + 'px'; he.style.left = x2 + 'px';
    bubble.style.top = Math.max(0, sl.offsetTop - 38) + 'px';
    bubble.style.left = Math.max(0, Math.min(Math.min(x1, x2), pre.clientWidth - 100)) + 'px';
  };

  window.clearSelection = function (cardId) {
    var cs = window.__tmsCardState && window.__tmsCardState[cardId];
    if (cs) cs.selection = null;
    var pre = selPre(cardId);
    if (pre) pre.querySelectorAll('.term-line.is-selected').forEach(function (l) { l.classList.remove('is-selected'); });
    window.positionHandlesAndBubble(cardId);
  };

  /** Tipp im Markier-Modus: die ganze Zeile (ohne Fuellzeichen); nochmal = aufheben. */
  window.handleLineTap = function (pre, line) {
    var id = pre.dataset.cardId;
    var cs = window.__tmsCardState && window.__tmsCardState[id];
    if (!cs) return;
    var i = Number(line.dataset.i);
    var len = lineText(line).replace(/\s+$/, '').length;
    var s0 = cs.selection;
    if (s0 && s0.start === i && s0.end === i && s0.sc === 0 && s0.ec === len) { window.clearSelection(id); return; }
    cs.selection = { start: i, end: i, sc: 0, ec: len };
    window.positionHandlesAndBubble(id);
  };

  window.makeBubble = function (cardId) {
    var el = document.createElement('button');
    el.className = 'copy-bubble';
    el.textContent = 'Kopieren';
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      var cs = window.__tmsCardState && window.__tmsCardState[cardId];
      var pre = selPre(cardId);
      if (!cs || !cs.selection || !pre) return;
      var sel = cs.selection;
      var text = window.copyRange(selRows(cardId, pre), selCols(cardId), sel.start, sel.sc, sel.end, sel.ec);
      if (!text) { window.toast && window.toast('Nichts markiert'); return; }
      window.copyText(text);
      if (window.toast) window.toast('Kopiert ✓');
      window.clearSelection(cardId);
    });
    return el;
  };

  /** Langer Druck: in den Markier-Modus, Wort bzw. ganzer Link unter dem Finger. */
  function startLineSelection(line, x) {
    var pre = line.closest('.card-body[data-card-id]');
    if (!pre) return;
    tapBlockUntil = Date.now() + 900; // nach dem Markieren keinen TUI-Klick senden
    var id = pre.getAttribute('data-card-id');
    if (!pre.classList.contains('selection-mode') && typeof window.toggleCardSelectionMode === 'function') {
      window.toggleCardSelectionMode(id, null);
    }
    var cs = window.__tmsCardState && window.__tmsCardState[id];
    if (!cs) return;
    var i = Number(line.dataset.i);
    var col = x === undefined ? 0 : colAt(pre, line, x, 'floor');
    var r = window.rangeAt(selRows(id, pre), selCols(id), i, col);
    // Auf Leerraum gedrueckt: dann eben die Zeile (wie bisher).
    if (r.sr === r.er && r.sc === r.ec) { window.handleLineTap(pre, line); }
    else { cs.selection = { start: r.sr, end: r.er, sc: r.sc, ec: r.ec }; window.positionHandlesAndBubble(id); }
    if (navigator.vibrate) navigator.vibrate(10);
  }

  // Langes Drücken feuert im Browser ohnehin ein contextmenu — und weil die
  // native Textauswahl app-weit aus ist, ist das Signal hier frei verwendbar.
  // Das ist zuverlässiger als ein eigener Timer (der nach einem vorherigen Tipp
  // nicht mehr durchkam).
  document.addEventListener('contextmenu', function (e) {
    var line = e.target.closest && e.target.closest('.card-body[data-card-id] .term-line');
    if (!line) return;
    e.preventDefault();
    startLineSelection(line, e.clientX);
  });

  // Langes Drücken auf eine Terminalzeile startet das Markieren — die einzige
  // Stelle in der App, an der überhaupt noch etwas markiert werden kann.
  var selHold = null, selMoved = false, selStart = null;
  document.addEventListener('pointerdown', function (e) {
    var line = e.target.closest && e.target.closest('.card-body[data-card-id] .term-line');
    if (!line) return;
    var pre = line.closest('.card-body[data-card-id]');
    var id = pre.getAttribute('data-card-id');
    selMoved = false;
    selStart = { x: e.clientX, y: e.clientY };
    clearTimeout(selHold);
    var holdX = e.clientX;
    selHold = setTimeout(function () {
      if (selMoved) return;
      startLineSelection(line, holdX);
    }, 550);
  }, true);
  document.addEventListener('pointermove', function (e) {
    if (!selStart) return;
    if (Math.abs(e.clientX - selStart.x) > 8 || Math.abs(e.clientY - selStart.y) > 8) {
      selMoved = true;               // gescrollt, nicht gedrückt gehalten
      clearTimeout(selHold);
    }
  }, true);
  document.addEventListener('pointerup', function () { clearTimeout(selHold); selStart = null; }, true);
  document.addEventListener('pointercancel', function () { clearTimeout(selHold); selStart = null; }, true);

  /** Kopier-Modus wirklich verlassen — das Mockup löschte nur die Auswahl. */
  function exitSelection(cardId) {
    var pre = document.querySelector('.card-body[data-card-id="' + cardId + '"]');
    if (!pre || !pre.classList.contains('selection-mode')) return;
    if (typeof window.clearSelection === 'function') window.clearSelection(cardId);
    if (typeof window.toggleCardSelectionMode === 'function') window.toggleCardSelectionMode(cardId, null);
  }
  function exitAllSelections() {
    document.querySelectorAll('.card-body.selection-mode[data-card-id]').forEach(function (p) {
      var id = p.getAttribute('data-card-id');
      // Cloud log viewers manage their own selection via the toolbar button —
      // this outside-tap exit killed the mode in the same click that enabled it.
      if (id.indexOf('cloud-') === 0) return;
      exitSelection(id);
    });
  }

  // Nach dem Kopieren ist man fertig — also raus aus dem Modus. Die Bubble des
  // Mockups stoppt die Weitergabe, deshalb hier in der Capture-Phase mitlesen.
  document.addEventListener('click', function (e) {
    var bub = e.target.closest && e.target.closest('.copy-bubble');
    if (!bub) return;
    var pre = bub.closest('.card-body[data-card-id]');
    var id = pre && pre.getAttribute('data-card-id');
    if (id) setTimeout(function () { exitSelection(id); }, 0);
  }, true);

  // Ein Tipp ins Terminal wählt es aus und setzt den Cursor in die EINGABEZEILE
  // unten — dort tippt man, sichtbar. Das versteckte Textfeld des Emulators zu
  // fokussieren hieß: blind tippen, und Androids Wortvorschlag machte Salat.
  document.addEventListener('click', function (e) {
    if (e.target.closest('.copy-bubble') || e.target.closest('.sel-handle')) return;
    var pre = e.target.closest && e.target.closest('.card-body[data-card-id]');

    // Irgendwo daneben tippen beendet den Kopier-Modus. Ohne das kam man da
    // nie wieder raus — und damit auch nicht zurück in die Eingabezeile.
    if (!pre || !e.target.closest('.term-line')) {
      exitAllSelections();
      if (!pre) return;
    }
    if (pre.classList.contains('selection-mode')) return; // Zeile antippen = auswählen

    if (e.target.closest('.wrapped-link') || e.target.closest('.jump-bottom-orb')) return;
    // Echte TUI mit Mouse-Reporting: den Tipp als Linksklick ins PTY geben.
    // Ohne das reagierten Tabs/Buttons von opencode nie — der Tipp landete nur
    // in der Eingabezeile der App. Ein Klick ist Druck + Loslassen an derselben
    // Zelle; bei Auswahl/Wischen ist er gesperrt (tapBlockUntil).
    if (e.detail > 0 && Date.now() >= tapBlockUntil) {
      sendTap(pre, e.target.closest('.term-line'), e.clientX);
    }
    var id = pre.getAttribute('data-card-id');
    if (window.__tmsState) window.__tmsState.activeCardId = id;
    if (typeof window.setDockPage === 'function') window.setDockPage('term');
    if (typeof window.syncDockTerminal === 'function') window.syncDockTerminal();
    var input = document.getElementById('dockInput');
    if (input && !input.disabled) input.focus();
  });
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
  window.cancelDictation = function (reason) {
    // Only the ✕ on the recording bar ('user') ends a real recording. The
    // mockup also calls cancelDictation() on every screen change, view toggle
    // and new terminal — each of those used to kill the dictation mid-sentence.
    if (reason !== 'user') return;
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
    /** Vordergrundprozess einer Session — vom Server beim Reattach mitgeschickt.
     *  Bekannte Maus-TUIs (opencode) bekommen ihre DECSET-Modi lokal zurueck,
     *  weil der Snapshot sie nicht enthaelt. */
    setProcessName: function (sessionId, name) {
      if (!sessionId) return;
      var cardId = cardOf(sessionId);
      var t = cardId && terms[cardId];
      var wasReal = t ? wantsRealRows(t) : false;
      procBySession[sessionId] = name || '';
      if (!t) return;
      t.forceMouse = isMouseTui(name);
      t.mouseForced = false;
      t.forceBlocked = false;
      forceMouseOn(t);
      if (wantsRealRows(t) !== wasReal) fitNow(cardId); // Maus-TUI: echte Höhe
    },
    /** Nach einem Reattach die WAHREN xterm-Maße über den normalen,
     *  beruhigten Resize-Weg bestätigen. Stimmen sie mit der PTY überein,
     *  ist das serverseitig ein No-op (kein SIGWINCH, kein Repaint); ging
     *  unterwegs ein Resize verloren, korrigiert genau EIN Resize mit der
     *  echten Breite. Die Maße aus dem Attach selbst sind dafür ungeeignet —
     *  sie entstehen mitten in Animationen und trugen schon fremde
     *  Kartenbreiten (vier Sessions, alle "39x32"). */
    assertDims: function (sessionId) {
      var cardId = cardOf(sessionId);
      var t = cardId && terms[cardId];
      if (!t || !t.term) return;
      // Dedupe aufheben: wurde das letzte Resize GESENDET, aber nie
      // zugestellt (Socket-Abriss), hielte lastDims die Bestätigung zurück.
      delete lastDims[sessionId];
      queueResize(cardId, t.term.cols, t.term.rows);
    },

    /** Re-create cards for PTY sessions that already exist on the server. */
    restoreSessions: function (list) {
      restoring = true;
      // Wiederherstellen ist kein Erstellen: addTerminal() ist der Weg des
      // Nutzers und meldet jede Karte per Toast ("Shell 2 erstellt"). Beim
      // Server-Wechsel prasselten so Meldungen über Terminals herein, die es
      // längst gab. Für die Dauer des Wiederherstellens schweigt der Toast.
      var origToast = window.toast;
      window.toast = function () {};
      list.forEach(function (item) {
        // Mehrere Geräte: die Karte landet in der Gruppe ihres Servers.
        window.__newTermServer = item.serverId || null;
        window.addTerminal();
        window.__newTermServer = null;
        var ids = [].map.call(document.querySelectorAll('.card-body[data-card-id]'), function (el) {
          return el.getAttribute('data-card-id');
        });
        var cardId = ids.filter(function (id) { return !(id in bound) && id.indexOf('cloud-') !== 0; }).pop();
        if (!cardId) return;
        bound[cardId] = item.sessionId;
        byCard[cardId] = item.sessionId;
        applyActivity(item.sessionId);
        // React Native braucht die Karten-ID (Notizen, Auto-Approve). Früher
        // rechnete es sie als t1..tN aus — mit mehreren Geräten stimmt das nicht mehr.
        post('terminal:restored', { cardId: cardId, sessionId: item.sessionId });
        if (item.name) {
          var sess = (window.TMS_DATA.sessions || []).find(function (x) { return x.id === cardId; });
          if (sess) sess.name = item.name;
          var nameEl = document.querySelector('.term-card[data-id="' + cardId + '"] .card-name');
          if (nameEl) nameEl.value = item.name;
        }
        mountTerm(cardId);
        // Ohne das hier hängt die Karte für immer leer da: der Server erfährt
        // nie, dass wir wieder da sind, und schickt entsprechend nichts.
        attachSized(cardId, item.sessionId);
      });
      restoring = false;
      window.toast = origToast;
      window.__tmsReportActive();
      if (typeof window.syncDockTerminal === 'function') window.syncDockTerminal();
      if (typeof window.renderTermSwitcher === 'function') window.renderTermSwitcher();
      // addTerminal() arms the rename field for a brand-new terminal; a restored
      // one is not new, so drop that focus again.
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      window.getSelection && window.getSelection().removeAllRanges();
    },
    /** A PTY session was created for a card we asked about. */
    /** Ein Push auf eine Umfrage wurde angetippt — genau dieses Terminal zeigen.
     *  Der Server pusst nur bei Umfragen, also bei Fragen, die er bewusst NICHT
     *  beantwortet; hier landet man also immer vor einer offenen Auswahl. */
    focusSession: function (sessionId) {
      var cardId = cardOf(sessionId);
      if (!cardId) return;
      if (typeof window.setDockPage === 'function') window.setDockPage('term');
      if (typeof window.focusTerminal === 'function') window.focusTerminal(cardId);
      if (window.__tmsState) window.__tmsState.activeCardId = cardId;
      if (typeof window.syncDockTerminal === 'function') window.syncDockTerminal();
      if (typeof window.renderTermSwitcher === 'function') window.renderTermSwitcher();
    },
    bindSession: function (cardId, sessionId) {
      bound[cardId] = sessionId;
      byCard[cardId] = sessionId;
      window.__tmsReportActive();
      applyActivity(sessionId);
      mountTerm(cardId);
      flush(cardId);
      if (typeof window.syncDockTerminal === 'function') window.syncDockTerminal();
      attachSized(cardId, sessionId);
    },
    /**
     * Titel vom Server (Quelle der Wahrheit, siehe server/src/terminal/titles.store.ts)
     * auf die Karte bringen — auch wenn er auf einem anderen Geraet gesetzt wurde.
     * Ein gerade bearbeitetes Namensfeld wird nicht ueberschrieben.
     */
    setCardTitle: function (sessionId, title) {
      var cardId = cardOf(sessionId);
      if (!cardId || !title) return;
      var sess = (window.TMS_DATA.sessions || []).find(function (x) { return x.id === cardId; });
      if (!sess || sess.name === title) return;
      sess.name = title;
      document.querySelectorAll('[data-id="' + cardId + '"] .card-name').forEach(function (el) {
        if (el.dataset.editing !== '1') el.value = title;
      });
      if (typeof window.renderTermSwitcher === 'function') window.renderTermSwitcher();
      if (typeof window.syncDockTerminal === 'function') window.syncDockTerminal();
      if (window.__tmsState && window.__tmsState.overviewOpen && typeof window.renderOverview === 'function') window.renderOverview();
    },
    /** PTY output. */
    output: function (sessionId, chunk) {
      var cardId = cardOf(sessionId);
      if (!cardId || !terms[cardId]) { (queued[sessionId] = queued[sessionId] || []).push(chunk); return; }
      writeTerm(terms[cardId], chunk, function () { scheduleRender(cardId); });
      refreshPreview(cardId);
    },
    /** App im Vordergrund? Im Hintergrund ruht das Malen (siehe __tmsCardVisible). */
    setAppActive: function (active) {
      var wasInactive = !!window.__tmsAppInactive;
      window.__tmsAppInactive = !active;
      if (active && wasInactive && typeof window.__tmsFlushHidden === 'function') {
        window.__tmsFlushHidden(); // nachzeichnen, was in der Pause aufgelaufen ist
      }
    },
    /** Session state -> the mockup's own status chip. */
    setSessionStatus: function (sessionId, status) {
      var cardId = cardOf(sessionId);
      if (cardId && typeof window.updateStatusChip === 'function') window.updateStatusChip(cardId, status);
    },
    /** Server-reported working directory -> the mockup's folder subtitle. */
    setSessionCwd: function (sessionId, cwd) {
      var cardId = cardOf(sessionId);
      if (cardId && typeof window.__tmsSetSessionCwd === 'function') window.__tmsSetSessionCwd(cardId, cwd);
    },
    /** A permission / question prompt from the AI tool. */
    prompt: function (sessionId, data) {
      var cardId = cardOf(sessionId);
      if (cardId && typeof window.handlePrompt === 'function') window.handlePrompt(cardId, data);
    },
    /** Connection state -> Dynamic Island + latency chips. */
    setStatus: function (info) {
      if (typeof window.setIslandActivity === 'function') window.setIslandActivity(info.kind || 'ok', info.label || '');
      var srvList = window.TMS_DATA.servers || [];
      var srv = srvList.find(function (x) { return x.primary; }) || srvList[0];
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
  var managerMic = null;
  // Die reale Verdrahtung der Eingabezeile. Ein voller Shell-Rebuild (neuer
  // Name/Provider) erzeugt frische Elemente — deshalb steckt sie in einer
  // Funktion, die initManagerScreen nach jedem Aufbau erneut aufruft.
  function wireManagerInputReal() {
    var managerInput = rewire('managerTextInput');
    managerMic = rewire('managerMicBtn');
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
        // Diktat wie im Terminal: das Dock wird zur Aufnahmeleiste (Wellenform +
        // Timer + Abbrechen/Uebernehmen). Gleiche mic:start/stop/cancel-Pipeline,
        // nur mit dem MANAGER_MIC-Token — RN routet das Transkript ueber
        // injectManagerInput in die Manager-Eingabezeile. confirm/cancel der Leiste
        // laufen ueber window.confirmDictation/cancelDictation (nutzen micCard).
        micCard = '__manager__';
        if (typeof window.dockRecordingStart === 'function') window.dockRecordingStart('mgr');
        post('mic:start', { cardId: '__manager__' });
      });
    }
  }
  window.__tmsWireManagerInput = wireManagerInputReal;
  wireManagerInputReal();

  // Kopf-Menü-Aktionen: das Mockup ruft diese window-Hooks, die Bridge macht
  // daraus echte Server-/RN-Aufrufe (sonst blieben es Demo-Toasts).
  window.managerSelectProvider = function (id, contextLength) {
    var payload = { providerId: id };
    if (typeof contextLength === 'number' && contextLength > 0) payload.contextLength = contextLength;
    post('manager:setProvider', payload);
  };
  window.managerClearChat = function () { post('manager:clear', {}); };
  window.managerAttach = function () { post('manager:attach', {}); };
  window.managerRemoveAttachment = function (index) { post('manager:removeAttachment', { index: index }); };

  // RN → Seite: Modelle, Anhänge, Transkript in die Eingabezeile.
  // ── Diktat-Bubble: Zustand für die Einstellungen (settings.js zeichnet) ──
  window.TMSBridge.bubbleStatus = function (st) {
    window.TMS_DATA.settings = window.TMS_DATA.settings || {};
    window.TMS_DATA.settings.bubble = st || null;
    if (typeof window.renderSettings === 'function') window.renderSettings();
  };
  /** Werte aus der App (Sperre, Login-Links, Hintergrund, Version …). */
  window.TMSBridge.setSettings = function (vals) {
    var cur = window.TMS_DATA.settings || {};
    window.TMS_DATA.settings = Object.assign({}, cur, vals || {}, { bubble: cur.bubble || null });
    if (typeof window.renderSettings === 'function') window.renderSettings();
  };

  /** Wörterbuch + Tempo vom Diktat-Rechner: { entries, speed } · { offline } · { unsupported }. */
  window.TMSBridge.setDictionary = function (data) {
    window.TMS_DATA.dictionary = data || null;
    if (typeof window.renderSettings === 'function') window.renderSettings();
  };

  window.TMSBridge.setManagerProviders = function (providers, active) {
    window.TMS_DATA.manager.providers = providers || [];
    window.TMS_DATA.manager.activeProvider = active || '';
    var nameEl = document.getElementById('mgrModelName');
    if (nameEl && typeof window.activeManagerModelName === 'function') nameEl.textContent = window.activeManagerModelName();
    // Ein offenes Modell-Sheet mit den frischen Daten (Ladezustand, Context) neu bauen.
    if (typeof window.__tmsRefreshModelSheet === 'function') window.__tmsRefreshModelSheet();
  };
  /** providerId, dessen lokales Modell gerade geladen wird ('' = keins). */
  window.TMSBridge.setManagerModelLoading = function (providerId) {
    window.TMS_DATA.manager.modelLoadingId = providerId || '';
    var nameEl = document.getElementById('mgrModelName');
    if (nameEl && typeof window.activeManagerModelName === 'function') nameEl.textContent = window.activeManagerModelName();
    if (typeof window.__tmsRefreshModelSheet === 'function') window.__tmsRefreshModelSheet();
  };
  window.TMSBridge.setManagerAttachments = function (list) {
    window.TMS_DATA.manager.attachments = list || [];
    if (typeof window.renderManagerAttachments === 'function') window.renderManagerAttachments();
  };
  // Transkript des Manager-Mikros: landet in der Eingabezeile zum Prüfen/Ändern,
  // NICHT sofort gesendet.
  window.TMSBridge.injectManagerInput = function (text) {
    micCard = null;
    // Schliesst die Aufnahmeleiste und setzt das Transkript in die Manager-Zeile
    // (dockRecordingEnd routet per Ziel 'mgr'); zum Pruefen/Senden, kein Auto-Send.
    if (typeof window.dockRecordingEnd === 'function') { window.dockRecordingEnd(text || '', 'mgr'); return; }
    var el = document.getElementById('managerTextInput');
    if (!el || !text) return;
    el.value = (el.value ? el.value + ' ' : '') + text;
    el.focus();
  };
  window.TMSBridge.managerMicStopped = function () {
    micCard = null;
    // Fehler/Abbruch beim Manager-Diktat: Aufnahmeleiste schliessen, zurueck zur Zeile.
    if (typeof window.dockRecordingEnd === 'function') window.dockRecordingEnd('', 'mgr');
  };

  // ══ Cloud ═════════════════════════════════════════════════════════════════
  var origOpenCloud = window.openCloudDetail;
  window.openCloudDetail = function (id, tab) {
    origOpenCloud(id, tab);
    post('cloud:open', { projectId: id });
  };
  // Account linking: the mockup's demo stubs become real round-trips.
  window.requestCloudConnect = function (provider, token) { post('cloud:connect', { provider: provider, token: token }); };
  window.requestCloudDisconnect = function (provider) { post('cloud:disconnect', { provider: provider }); };
  window.requestCloudRevealKey = function (provider) { post('cloud:revealKey', { provider: provider }); };
  window.requestCloudCopyKey = function (provider) { post('cloud:copyKey', { provider: provider }); };
  window.requestCloudOrgUpdate = function (org) { post('cloud:org:update', { org: org }); };
  // API-Key-Seite des Anbieters im geteilten Login-Tab (WebBrowser) öffnen — der
  // isolierte In-App-WebView würde an Render/Vercel-OAuth (Google/GitHub) scheitern.
  window.requestCloudTokenPage = function (provider) { post('cloud:openTokenPage', { provider: provider }); };

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

  // Der native WebView liegt ÜBER der ganzen Deck-WebView — alles, was das Deck
  // selbst als Overlay zeichnet (Tab-Liste, Menü, Werkzeuge, Spotlight, die
  // aufgeklappte Insel, der Sperrbildschirm), läge sonst DAHINTER und wäre
  // unbedienbar. Solange so ein Overlay offen ist, verschwindet die Seite.
  function overlayOpen() {
    if (document.body.classList.contains('is-locked')) return true;
    var header = document.getElementById('statusHeader');
    if (header && header.classList.contains('is-expanded')) return true;
    return !!document.querySelector('.sheet-wrap:not([hidden])');
  }
  /** Steht der Browser-Bildschirm vorn? (Overlays darüber zählen hier NICHT.) */
  function browserVisible2() {
    var screen = document.querySelector('[data-screen="browser"]');
    return !!screen && !screen.hidden;
  }
  /** Und ist die Seite selbst gerade zu SEHEN — also kein Overlay darüber? */
  function browserVisible() {
    return browserVisible2() && !overlayOpen();
  }
  // Nur melden, wenn sich wirklich etwas geändert hat. Der Beobachter unten hängt
  // an den Body-Klassen — und die legt die Seite dauernd um (Ruhemodus, Tastenleiste,
  // Theme). Jede Meldung ließ React Native neu rendern und reichte dem nativen
  // WebView eine frische Quelle: er lud die Seite immer wieder neu. Weißes Bild.
  var lastSync = '';
  function postSync(payload) {
    var sig = JSON.stringify(payload);
    if (sig === lastSync) return;
    lastSync = sig;
    post('browser:sync', payload);
  }
  function syncNativeBrowser() {
    var tab = window.activeBrowserTab && window.activeBrowserTab();
    var host = document.getElementById('browserContent');
    if (!tab || !host) { postSync({ visible: false, onBrowserScreen: browserVisible2() }); return; }
    var page = tab.history[tab.historyIndex] || {};
    var r = host.getBoundingClientRect();
    postSync({
      visible: browserVisible() && page.kind !== 'newtab',
      // WÄRME: „verdeckt" und „Bildschirm verlassen" sind zweierlei. Ein offenes
      // Sheet blendet die Seite nur aus (sie bleibt am Leben, sonst lüde sie beim
      // Schließen neu). Verlässt man den Browser aber ganz, muss der native
      // WebView WEG — ausgeblendet führt Android sein JavaScript weiter aus, und
      // ein Dashboard-Tab pollt und animiert dann stundenlang im Hintergrund.
      onBrowserScreen: browserVisible2(),
      tabId: tab.id,
      url: page.kind === 'newtab' ? '' : page.url || '',
      // Auf ganze Pixel runden: Sub-Pixel-Zittern beim Scrollen erzeugte sonst
      // endlos "neue" Rechtecke und damit endlos Meldungen.
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
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
  // Zurück/vor gehen NICHT mehr über die Deck-Attrappen-Historie (die kannte nur
  // getippte Adressen, keine Link-Klicks), sondern über die echte Historie des
  // nativen WebViews. Die Knopf-Aktivierung kommt aus den canGoBack/canGoForward-
  // Meldungen des WebViews (siehe browserTitle + der syncBrowserChrome-Wrap unten).
  window.browserGoBack = function () { post('browser:back', {}); };
  window.browserGoForward = function () { post('browser:forward', {}); };
  var origSyncChrome = window.syncBrowserChrome;
  window.syncBrowserChrome = function () {
    if (typeof origSyncChrome === 'function') origSyncChrome();
    var tab = window.activeBrowserTab && window.activeBrowserTab();
    var backBtn = document.getElementById('browserBackBtn');
    var fwdBtn = document.getElementById('browserFwdBtn');
    // Auf einer leeren neuen Seite gibt es keinen WebView → immer gesperrt.
    var page = tab && tab.history[tab.historyIndex];
    var live = !!tab && !!page && page.kind !== 'newtab';
    if (backBtn) backBtn.disabled = !live || !tab._canGoBack;
    if (fwdBtn) fwdBtn.disabled = !live || !tab._canGoForward;
  };
  // Der Entwurf "leerte" nur seine eigenen Attrappen-Sitzungen und malte einen
  // leeren Platzhalter — der native Browser behielt Cache und Anmeldungen. Jetzt
  // geht der Befehl dorthin, wo die Seite wirklich lebt.
  window.clearAllBrowserCache = function () {
    post('browser:clearCache', {});
    if (typeof window.toast === 'function') window.toast('Cache geleert — Seite wird neu geladen');
  };

  // Screen changes drive the overlay: it must never float over Terminals.
  // Zugleich die Stelle, an der die Bildschirm-Historie mitgeschrieben wird —
  // ohne sie hätte die Zurück-Geste nichts, wohin sie zurückgehen könnte.
  var screenHistory = [];
  var curScreen = 'terminals';
  var goingBack = false;
  var origShow = window.show;
  window.show = function (name) {
    if (!goingBack && name !== curScreen) {
      screenHistory.push(curScreen);
      if (screenHistory.length > 20) screenHistory.shift();
    }
    curScreen = name;
    origShow(name);
    post('nav:screen', { screen: name });
    window.__tmsReportFocus();
    if (name === 'browser') setTimeout(syncNativeBrowser, 80);
    // Bildschirm verlassen: der native WebView wird nicht nur unsichtbar, er wird
    // ABGEBAUT (onBrowserScreen: false) — sonst liefe seine Seite im Hintergrund weiter.
    else post('browser:sync', { visible: false, onBrowserScreen: false });
  };

  // ══ Zurück-Geste ══════════════════════════════════════════════════════════
  // Android schickt jedes Zurück-Wischen hierher, statt die App zu beenden.
  // Abgeräumt wird von oben nach unten: erst was über dem Bildschirm liegt,
  // dann der Bildschirm selbst. Erst wenn nichts mehr übrig ist, darf React
  // Native ans Beenden denken (und fragt dann noch einmal nach).
  window.TMSBridge.handleBack = function () {
    if (window.TMSCompact && window.TMSCompact.closeOverlay()) return;
    // 0. Fernzugriff im Vollbild: die Zurück-Geste wirkt wie das Abzeichen
    //    (#remoteExit) — verlässt das Vollbild, nicht den Fernzugriffs-
    //    Bildschirm selbst. Ohne das leiten die Dokument-Zuhörer für
    //    Tastatur/Zeiger/Rad (siehe bridge.js) weiter an den PC, während der
    //    Nutzer mit der Geste erkennbar zurückwollte — genau der Fall, für
    //    den der Vollbild-Modus überhaupt existiert (Hardware am Fold), darf
    //    also nicht ausgerechnet dort die Zurück-Geste verschlucken.
    if (window.remoteState && window.remoteState.fullscreen) {
      window.setRemoteFullscreen(false);
      return;
    }
    // 1. Ein offenes Sheet (Tab-Liste, Werkzeuge, Menü, Spotlight …). Bewusst
    //    .is-open und nicht :not([hidden]) — ein gerade zufallendes Sheet würde
    //    sonst den Zurück-Druck schlucken, ohne noch etwas zu tun.
    var sheet = document.querySelector('.sheet-wrap.is-open');
    if (sheet && typeof window.closeSheet === 'function') { window.closeSheet(sheet); return; }
    // 1b. Einstellungen: Unterseite → Übersicht (bzw. Suche leeren)
    if (typeof window.__settingsBack === 'function' && window.__settingsBack()) return;
    // 2. Die aufgeklappte Insel
    var header = document.getElementById('statusHeader');
    if (header && header.classList.contains('is-expanded')) {
      var scrim = document.getElementById('islandScrim');
      if (scrim) scrim.click();
      return;
    }
    // 3. Die Terminal-Übersicht
    if (window.__tmsState && window.__tmsState.overviewOpen && typeof window.toggleOverview === 'function') {
      window.toggleOverview(false);
      return;
    }
    // 4. Die Tastenleiste
    if (window.__tmsState && window.__tmsState.keysPanelOpen && typeof window.closeKeysPanel === 'function') {
      window.closeKeysPanel();
      return;
    }
    // 4b. Auf der Browser-Seite zuerst durch die ECHTE Seiten-Historie des
    //     WebViews zurück (Link-Klicks, Weiterleitungen) — genau wie der ◄-Knopf.
    //     Erst wenn die Seite nicht mehr zurück kann, verlässt der Zurück-Druck
    //     den Browser-Bildschirm (Schritt 5). Wie in Chrome auf Android.
    if (curScreen === 'browser') {
      var bTab = window.activeBrowserTab && window.activeBrowserTab();
      if (bTab && bTab._canGoBack) { post('browser:back', {}); return; }
    }
    // 5. Der vorherige Bildschirm
    if (screenHistory.length) {
      goingBack = true;
      var prev = screenHistory.pop();
      window.show(prev);
      goingBack = false;
      return;
    }
    // 6. Kein Weg mehr zurück, aber auch nicht auf den Terminals: dorthin.
    if (curScreen !== 'terminals') {
      goingBack = true;
      window.show('terminals');
      goingBack = false;
      return;
    }
    // 7. Wirklich am Anfang — jetzt entscheidet React Native.
    post('nav:exit', {});
  };
  window.addEventListener('resize', function () { if (browserVisible()) syncNativeBrowser(); });

  // Die Sheets öffnen/schließen sich im Deck ohne Umweg über die Bridge — also
  // horchen wir direkt auf ihren Zustand, statt jede einzelne Funktion zu
  // umwickeln. Beobachtet werden nur die Attribute weniger fester Elemente
  // (keine Terminal-Ausgabe), das kostet praktisch nichts.
  var overlayWatch = new MutationObserver(function () {
    if (overlaySyncQueued) return;
    overlaySyncQueued = true;
    requestAnimationFrame(function () {
      overlaySyncQueued = false;
      syncNativeBrowser();
    });
  });
  var overlaySyncQueued = false;
  function watchOverlays() {
    var opts = { attributes: true, attributeFilter: ['class', 'hidden'] };
    overlayWatch.observe(document.body, opts);
    var header = document.getElementById('statusHeader');
    if (header) overlayWatch.observe(header, opts);
    document.querySelectorAll('.sheet-wrap').forEach(function (el) { overlayWatch.observe(el, opts); });
  }
  watchOverlays();

  // ══ React Native → WebView (Manager / Cloud / Browser) ═════════════════════
  window.TMSBridge.setManager = function (messages) {
    window.TMS_DATA.manager.messages = messages;
    if (managerMic) managerMic.classList.remove('is-recording');
    if (typeof window.renderManagerChat === 'function') window.renderManagerChat();
  };
  // Name + Profilbild des Managers (aus den Persönlichkeits-Einstellungen). Der
  // Kopf sitzt in der Shell, darum bei Änderung die ganze Manager-Ansicht neu
  // aufbauen — passiert selten (nur wenn man Name/Bild ändert).
  window.TMSBridge.setManagerPersona = function (name, avatar) {
    var p = window.TMS_DATA.manager.persona || (window.TMS_DATA.manager.persona = {});
    p.name = name || 'Manager';
    p.avatar = avatar || null;
    if (typeof window.renderManagerShell === 'function' && typeof window.rerenderManager === 'function') {
      window.rerenderManager();
    }
  };
  window.TMSBridge.setCloud = function (projects) {
    window.TMS_DATA.cloudProjects = projects;
    if (typeof window.renderCloudFolderBar === 'function') window.renderCloudFolderBar();
    if (typeof window.renderCloudGroups === 'function') window.renderCloudGroups();
  };
  window.TMSBridge.setCloudOrg = function (org) {
    window.TMS_DATA.cloudOrg = org;
    // One-time migration: favorites older versions kept in page-localStorage.
    try {
      var raw = localStorage.getItem('tms-liquid-deck-cloud-favorites');
      if (raw) {
        var legacy = JSON.parse(raw);
        Object.keys(legacy).forEach(function (pid) { if (legacy[pid]) org.favorites[pid] = true; });
        localStorage.removeItem('tms-liquid-deck-cloud-favorites');
        window.requestCloudOrgUpdate(org);
      }
    } catch (e) {}
    if (typeof window.renderCloudFolderBar === 'function') window.renderCloudFolderBar();
    if (typeof window.renderCloudGroups === 'function') window.renderCloudGroups();
  };
  window.TMSBridge.setCloudAccounts = function (accounts) {
    window.TMS_DATA.cloudAccounts = accounts;
    if (typeof window.renderCloudGroups === 'function') window.renderCloudGroups();
    if (typeof window.renderCloudAccountsSheet === 'function') window.renderCloudAccountsSheet();
  };
  window.TMSBridge.cloudKeyRevealed = function (provider, key) {
    if (typeof window.cloudKeyRevealed === 'function') window.cloudKeyRevealed(provider, key);
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
  window.TMSBridge.browserTitle = function (tabId, title, url, canGoBack, canGoForward) {
    var tab = (window.activeBrowserTab && window.activeBrowserTab()) || null;
    if (!tab || tab.id !== tabId) return;
    // Die echte Navigierbarkeit des WebViews merken — daran hängen die Knöpfe.
    tab._canGoBack = !!canGoBack;
    tab._canGoForward = !!canGoForward;
    var page = tab.history[tab.historyIndex];
    if (page && page.kind !== 'newtab') {
      if (title) page.display = title;
      // Link-Klicks/Weiterleitungen ändern die Adresse im WebView — die Leiste
      // zieht mit, ohne einen neuen Verlaufseintrag zu erfinden.
      if (url) page.url = url;
    }
    if (typeof window.syncBrowserChrome === 'function') window.syncBrowserChrome();
  };
  window.TMSBridge.browserSync = syncNativeBrowser;

  // ══ Gemeinsame Zwischenablage (Handy ⇄ Mac) ══════════════════════════════
  // Der Verlauf gehoert dem Server (server/src/clipboard): Kopien am Mac meldet
  // der Mac-Helfer, Kopien in der App gehen ueber clipboard:write hin. Die App
  // (SeasonTwoWebRoot) legt Gewaehltes auf die Handy-Zwischenablage und liest
  // beim Oeffnen, was zuletzt in anderen Handy-Apps kopiert wurde.
  window.__clipItems = []; // keine Demo-Eintraege in der echten App
  window.clipOnOpen = function () { post('clipboard:open', {}); };
  window.clipUse = function (item) { post('clipboard:use', { id: item.id, text: item.text }); };
  window.clipDelete = function (id) { post('clipboard:delete', { id: id }); };
  window.clipClear = function () { post('clipboard:clear', {}); };
  function clipChanged() { if (typeof window.clipRender === 'function') window.clipRender(); }
  window.TMSBridge.clipboardSet = function (items) {
    window.__clipItems = Array.isArray(items) ? items : [];
    clipChanged();
  };
  window.TMSBridge.clipboardAdded = function (item, removed) {
    if (!item || typeof item.text !== 'string') return;
    var drop = {};
    (removed || []).forEach(function (id) { drop[id] = true; });
    drop[item.id] = true;
    window.__clipItems = [item].concat(window.__clipItems.filter(function (x) { return !drop[x.id]; })).slice(0, 40);
    clipChanged();
  };
  window.TMSBridge.clipboardRemoved = function (ids) {
    var drop = {};
    (ids || []).forEach(function (id) { drop[id] = true; });
    window.__clipItems = window.__clipItems.filter(function (x) { return !drop[x.id]; });
    clipChanged();
  };

  // ══ Werkzeug-Sheets ═══════════════════════════════════════════════════════
  // Each sheet renders straight out of TMS_DATA[key], so the whole job is to
  // put real data there and to make the taps do real work.
  var origOpenTool = window.openToolSheet;
  var openTool = null;
  window.openToolSheet = function (id) {
    // Bund-Karten (Explorer, Zwischenablage, Snippets) holen ihre Daten selbst.
    // Hier NICHT als offen merken: sonst baut jedes setTool der App sie neu auf —
    // Snippets sprangen in einer Endlosschleife immer wieder auf.
    if (window.__bundTool && window.__bundTool(id)) return;
    openTool = id;
    origOpenTool(id);
    post('tool:open', { tool: id });
  };
  var origCloseSheet = window.closeSheet;
  window.closeSheet = function (el) {
    origCloseSheet(el);
    openTool = null;
  };

  // Snippets und Screenshot-Pfade gehören in das Terminal, das die Leiste
  // gerade bedient — nicht in irgendeines.
  function activeCardId() {
    if (typeof window.dockTargetId === 'function') {
      var id = window.dockTargetId();
      if (id) return id;
    }
    var el = document.querySelector('.term-card.is-target[data-id], .term-card[data-id]');
    return el ? el.getAttribute('data-id') : null;
  }

  // ── Datei-Explorer ────────────────────────────────────────────────────────
  // Der alte Explorer der App konnte alles: navigieren, suchen, Favoriten,
  // Vorschau, Herunterladen, Umbenennen, Löschen, Ordner anlegen. Der hier kann
  // es wieder — und zusätzlich das, wofür er im Terminal gebraucht wird: einen
  // Pfad direkt in die Eingabezeile legen.
  window.__tmsCwd = '~';
  window.__tmsFavs = [];

  // ── Files screen (real data layer) ─────────────────────────────────────
  // The fullscreen explorer in the mockup renders through window.fs* hooks;
  // here they get real URLs, real listings, and real actions.
  var fsBase = '', fsToken = '';
  window.TMSBridge.setFilesBase = function (base, token) { fsBase = base; fsToken = token; };
  window.fsFileUrl = function (p) {
    return fsBase ? fsBase + '/files/download?path=' + encodeURIComponent(p) + '&token=' + encodeURIComponent(fsToken) : '';
  };
  window.fsPdfUrl = function (p) {
    return fsBase ? fsBase + '/files/pdfjs/web/viewer.html?file=' + encodeURIComponent(window.fsFileUrl(p)) : '';
  };
  window.fsListDir = function (path) { post('files:listRaw', { path: path }); };
  /** Gerätewechsel: der Ordner des alten Geräts gilt nicht mehr. */
  window.TMSBridge.resetFilesDir = function () {
    window.__tmsCwd = '~';
    if (window.fsResetDir) window.fsResetDir();
  };
  window.TMSBridge.setFilesDir = function (path, entries, srvId) {
    if (window.fsSetDir) window.fsSetDir(path, entries, srvId);
    window.__tmsCwd = path; // Sheet und Screen teilen sich den Ort
  };
  /** Favoriten-Ordner des Explorers, vom Handy-Speicher (alle Geräte). */
  window.TMSBridge.setFileFavs = function (map) { if (window.fsSetFavs) window.fsSetFavs(map || {}); };
  window.fsReadFile = function (path) { post('files:readRaw', { path: path }); };
  window.TMSBridge.fileContent = function (path, content, error, truncated) {
    if (window.fsSetFileContent) window.fsSetFileContent(path, content, error, truncated);
  };
  window.TMSBridge.downloadProgress = function (id, name, pct, state) {
    if (window.fsDownloadProgress) window.fsDownloadProgress(id, name, pct, state);
  };
  function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  window.fsAction = function (a, pl) {
    if (a === 'copyPath') {
      window.copyText(pl.paths.join('\n'));
      toast(pl.paths.length > 1 ? pl.paths.length + ' Pfade kopiert' : 'Pfad kopiert');
    } else if (a === 'cd') {
      var card = activeCardId();
      if (!card) { toast('Kein Terminal offen'); return; }
      window.__tmsInput(card, 'cd ' + shq(pl.path) + '\r');
      window.show('terminals');
    } else if (a === 'insert') {
      insertIntoTerminal(pl.path, 'Pfad eingefügt');
    } else if (a === 'download') {
      post('files:downloadToFolder', { paths: pl.paths, zip: !!pl.zip });
    } else if (a === 'share') {
      post('files:share', { path: pl.path });
    } else if (a === 'rename') {
      post('files:rename', { path: pl.path, name: pl.name });
    } else if (a === 'trash') {
      post('files:trashMany', { paths: pl.paths });
    } else if (a === 'fav') {
      post('files:fav', { path: pl.path });
    } else if (a === 'mkdir') {
      post('files:mkdirAbs', { path: pl.path });
    }
  };

  var filesFilter = '';
  var filesMenuFor = null;   // Pfad, dessen Aktionsleiste offen ist
  var filesRenaming = null;  // Pfad, der gerade umbenannt wird
  var filesConfirmDel = null;
  var filesNewFolder = false;

  // Kein ⋯ und kein langes Drücken mehr: ein Tipp auf eine DATEI öffnet ihr
  // Aktionsmenü (Einfügen ist dort der erste Eintrag — das Sofort-Einfügen
  // beim Tippen traf zu oft versehentlich). Ordner öffnen weiterhin direkt,
  // sonst würde jede Navigationsebene einen Zwischen-Tipp kosten.
  function fileRowHtml(f) {
    var isDir = f.type === 'dir';
    var path = f.path || '';
    var head = '<button class="tool-row is-tap" ' + (isDir ? 'data-cd="' : 'data-path="') + escapeHtml(isDir ? f.name : path) + '"' +
      ' data-fxpath="' + escapeHtml(path) + '" data-fxdir="' + (isDir ? '1' : '0') + '" data-fxname="' + escapeHtml(f.name) + '">' +
      '<span class="tool-row__icon">' + (isDir ? '▸' : '·') + '</span>' +
      '<span class="tool-row__name">' + escapeHtml(f.name) + '</span>' +
      '<span class="tool-row__meta">' + escapeHtml(isDir ? 'öffnen' : (f.size || '')) + '</span>' +
      '</button>';
    return '<div class="fx-row">' + head + '</div>';
  }

  /**
   * Das gemeinsame Aktionsmenü — eine Liste von Knöpfen, die von unten
   * hereinfährt. Favoriten und Dateizeilen teilen es sich, damit langes Drücken
   * überall dasselbe bedeutet und auch gleich aussieht.
   * items: [{ label, danger, confirm, run }] — confirm heißt: erst der zweite
   * Tipp führt aus (Löschen).
   */
  function openActionSheet(title, items) {
    var old = document.getElementById('fxFavMenu');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'fxFavMenu';
    el.style.cssText = 'position:fixed;inset:0;z-index:80;display:flex;flex-direction:column;justify-content:flex-end;background:rgba(0,0,0,.45)';
    el.innerHTML = '<div class="glass" style="border-radius:22px 22px 0 0;padding:14px 14px calc(14px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:6px;max-height:80vh;overflow-y:auto">' +
      '<div style="font-weight:800;font-size:13px;padding:2px 4px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(title) + '</div>' +
      items.map(function (it, i) {
        return '<button class="btn-chip' + (it.danger ? ' btn-chip--danger' : '') + '" data-fm="' + i + '">' + escapeHtml(it.label) + '</button>';
      }).join('') +
      '<button class="btn-chip" data-fm="close">Abbrechen</button></div>';
    document.body.appendChild(el);
    if (navigator.vibrate) navigator.vibrate(8);
    el.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-fm]');
      if (!btn) { if (ev.target === el) el.remove(); return; }
      if (btn.dataset.fm === 'close') { el.remove(); return; }
      var it = items[Number(btn.dataset.fm)];
      if (!it) return;
      // Löschen fragt einmal nach — im Menü selbst, ohne es zu schließen.
      if (it.confirm && btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.textContent = 'Wirklich löschen?';
        return;
      }
      el.remove();
      it.run();
    });
  }

  /** Favorit (nur der Pfad bekannt — daher die drei Aktionen ohne isDir/Größe). */
  function openFavMenu(p) {
    openActionSheet('★ ' + (p.split('/').pop() || p), [
      { label: 'Öffnen', run: function () { post('files:goto', { path: p }); } },
      { label: 'Pfad kopieren', run: function () { window.fsAction('copyPath', { paths: [p] }); } },
      { label: 'Im Terminal öffnen (cd)', run: function () { closeToolSheet(); window.fsAction('cd', { path: p }); } },
      { label: 'Favorit entfernen', danger: true, run: function () { post('files:fav', { path: p }); } },
    ]);
  }

  function closeToolSheet() {
    var wrap = document.getElementById('toolSheetWrap');
    if (wrap && typeof window.closeSheet === 'function') window.closeSheet(wrap);
  }

  /** Dateizeile: alles, was vorher hinter dem ⋯ steckte. */
  function openFileMenu(path, isDir, name) {
    var fav = window.__tmsFavs.indexOf(path) !== -1;
    var items = [];
    if (isDir) {
      items.push({ label: 'Öffnen', run: function () { post('files:goto', { path: path }); } });
      items.push({ label: 'Im Terminal öffnen (cd)', run: function () { closeToolSheet(); window.fsAction('cd', { path: path }); } });
    } else {
      items.push({ label: 'Einfügen', run: function () { insertIntoTerminal(path, 'Pfad eingefügt'); } });
      items.push({ label: 'Vorschau', run: function () { post('files:preview', { path: path }); } });
      items.push({ label: 'Laden', run: function () { post('files:download', { path: path }); } });
    }
    items.push({ label: 'Pfad kopieren', run: function () { window.fsAction('copyPath', { paths: [path] }); } });
    items.push({ label: 'Umbenennen', run: function () { filesRenaming = path; window.TMSBridge.setTool('files', window.TMS_DATA.files, window.__tmsCwd); } });
    items.push({ label: fav ? '★ Favorit entfernen' : '☆ Als Favorit merken', run: function () { post('files:fav', { path: path }); } });
    items.push({ label: 'Löschen', danger: true, confirm: true, run: function () { post('files:trash', { path: path }); } });
    openActionSheet((isDir ? '▸ ' : '') + (name || path.split('/').pop() || path), items);
  }

  window.buildFilesSheet = function () {
    var all = window.TMS_DATA.files || [];
    var q = filesFilter.toLowerCase();
    var files = q ? all.filter(function (f) { return f.name.toLowerCase().indexOf(q) !== -1; }) : all;

    var favs = window.__tmsFavs.length
      ? '<div class="fx-favs">' + window.__tmsFavs.map(function (p) {
          return '<button class="btn-chip" data-fx="gofav" data-target="' + escapeHtml(p) + '">★ ' +
            escapeHtml(p.split('/').pop() || p) + '</button>';
        }).join('') + '</div>'
      : '';

    var newFolder = filesNewFolder
      ? '<div class="tool-row"><input class="term-input fx-input" id="fxNewFolder" placeholder="Ordnername…">' +
        '<button class="btn-chip" data-fx="mkdir-ok">Anlegen</button>' +
        '<button class="btn-chip" data-fx="cancel">Abbrechen</button></div>'
      : '';

    var renaming = filesRenaming
      ? '<div class="tool-row"><input class="term-input fx-input" id="fxRename" placeholder="Neuer Name…" value="' +
        escapeHtml(filesRenaming.split('/').pop() || '') + '">' +
        '<button class="btn-chip" data-fx="rename-ok">Umbenennen</button>' +
        '<button class="btn-chip" data-fx="cancel">Abbrechen</button></div>'
      : '';

    var html =
      // Minimaler Abstand zwischen den Zeilen: jede wird eine flache Karte
      // statt Teil einer mit Linien getrennten Liste — trennt die Einträge
      // optisch, ohne die Liste in die Länge zu ziehen.
      '<style>' +
        '#toolSheetBody .fx-row + .fx-row { margin-top: 6px; }' +
        '#toolSheetBody .fx-row .tool-row { border-top: none; background: rgba(var(--overlay-rgb), .04); border-radius: 12px; padding: 11px 12px; }' +
      '</style>' +
      '<div class="fx-head">' +
        '<button class="btn-chip" data-cd="..">▴ Aufwärts</button>' +
        '<span class="fx-path mono-text">' + escapeHtml(window.__tmsCwd) + '</span>' +
        '<button class="btn-chip" data-fx="cdhere" aria-label="Diesen Ordner im Terminal öffnen">cd hier</button>' +
        '<button class="btn-chip" data-fx="newfolder">+ Ordner</button>' +
        '<button class="btn-chip" data-fx="fullscreen" aria-label="Vollbild-Explorer">⛶</button>' +
      '</div>' +
      '<input class="term-input fx-search" id="fxSearch" placeholder="Filtern…" value="' + escapeHtml(filesFilter) + '">' +
      favs + newFolder + renaming +
      '<div class="tool-list">' + (files.length
        ? files.map(fileRowHtml).join('')
        : '<div class="tool-empty">Nichts gefunden.</div>') + '</div>';

    return {
      html: html,
      wire: function () {
        var body = document.getElementById('toolSheetBody');

        var search = document.getElementById('fxSearch');
        if (search) {
          search.addEventListener('input', function () {
            filesFilter = search.value;
            var list = body.querySelector('.tool-list');
            var all2 = window.TMS_DATA.files || [];
            var q2 = filesFilter.toLowerCase();
            var f2 = q2 ? all2.filter(function (f) { return f.name.toLowerCase().indexOf(q2) !== -1; }) : all2;
            list.innerHTML = f2.length ? f2.map(fileRowHtml).join('') : '<div class="tool-empty">Nichts gefunden.</div>';
            wireRows();
          });
        }
        var nf = document.getElementById('fxNewFolder');
        if (nf) nf.focus();
        var rn = document.getElementById('fxRename');
        if (rn) { rn.focus(); rn.select(); }

        function rerender() { filesFilter = filesFilter; window.TMSBridge.setTool('files', window.TMS_DATA.files, window.__tmsCwd); }

        function wireRows() {
          body.querySelectorAll('[data-cd]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              filesMenuFor = null; filesConfirmDel = null; filesFilter = '';
              post('files:cd', { name: btn.dataset.cd });
            });
          });
          body.querySelectorAll('[data-path]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              openFileMenu(btn.dataset.fxpath, false, btn.dataset.fxname);
            });
          });
          body.querySelectorAll('[data-fx]').forEach(function (btn) {
            // Favoriten-Chips: Long-Press öffnet ein Mini-Menü (Pfad kopieren,
            // cd, entfernen) statt sofort hineinzunavigieren — ein Fingertipp
            // bleibt "öffnen", genau wie bei den normalen Zeilen.
            var lpTimer = null, lpFired = false;
            if (btn.dataset.fx === 'gofav') {
              btn.addEventListener('pointerdown', function () {
                lpFired = false;
                lpTimer = setTimeout(function () { lpFired = true; openFavMenu(btn.dataset.target); }, 550);
              });
              ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
                btn.addEventListener(ev, function () { clearTimeout(lpTimer); });
              });
            }
            btn.addEventListener('click', function (e) {
              e.stopPropagation();
              if (lpFired) { lpFired = false; return; }
              var a = btn.dataset.fx, t = btn.dataset.target;
              if (a === 'menu') { filesMenuFor = filesMenuFor === t ? null : t; filesConfirmDel = null; rerender(); }
              else if (a === 'copyPath') window.fsAction('copyPath', { paths: [t] });
              else if (a === 'cd') {
                var wrapCd = document.getElementById('toolSheetWrap');
                if (wrapCd && typeof window.closeSheet === 'function') window.closeSheet(wrapCd);
                window.fsAction('cd', { path: t });
              }
              else if (a === 'cdhere') {
                var wrapCdh = document.getElementById('toolSheetWrap');
                if (wrapCdh && typeof window.closeSheet === 'function') window.closeSheet(wrapCdh);
                window.fsAction('cd', { path: window.__tmsCwd });
              }
              else if (a === 'insert') insertIntoTerminal(t, 'Pfad eingefügt');
              else if (a === 'preview') post('files:preview', { path: t });
              else if (a === 'download') post('files:download', { path: t });
              else if (a === 'fav') { post('files:fav', { path: t }); }
              else if (a === 'rename') { filesRenaming = t; rerender(); }
              else if (a === 'rename-ok') {
                var v = document.getElementById('fxRename');
                if (v && v.value.trim()) {
                  post('files:rename', { path: filesRenaming, name: v.value.trim() });
                  // 'files:rename' refreshes the fullscreen explorer's list (a
                  // different RN hook) — kick THIS sheet's own list too, or
                  // the renamed entry keeps showing its old name here.
                  post('files:goto', { path: window.__tmsCwd });
                }
                filesRenaming = null;
              }
              else if (a === 'del') {
                if (filesConfirmDel !== t) { filesConfirmDel = t; rerender(); }
                else { post('files:trash', { path: t }); filesConfirmDel = null; filesMenuFor = null; }
              }
              else if (a === 'newfolder') { filesNewFolder = true; rerender(); }
              else if (a === 'mkdir-ok') {
                var n = document.getElementById('fxNewFolder');
                if (n && n.value.trim()) post('files:mkdir', { name: n.value.trim() });
                filesNewFolder = false;
              }
              else if (a === 'cancel') { filesNewFolder = false; filesRenaming = null; rerender(); }
              else if (a === 'gofav') { filesMenuFor = null; post('files:goto', { path: t }); }
              else if (a === 'fullscreen') {
                var wrap2 = document.getElementById('toolSheetWrap');
                if (wrap2 && typeof window.closeSheet === 'function') window.closeSheet(wrap2);
                if (window.openFilesScreen) window.openFilesScreen(window.__tmsCwd);
              }
            });
          });
        }
        wireRows();
      },
    };
  };

  /** Textvorschau einer Datei — kommt aus /files/read. */
  window.TMSBridge.filePreview = function (name, content) {
    var body = document.getElementById('toolSheetBody');
    if (!body) return;
    document.getElementById('toolSheetTitle').textContent = name;
    body.innerHTML = '<button class="btn-chip" id="fxBack">◂ Zurück</button>' +
      '<pre class="fx-preview mono-text">' + escapeHtml(content || '') + '</pre>';
    document.getElementById('fxBack').addEventListener('click', function () { window.openToolSheet('files'); });
  };
  window.TMSBridge.setFavs = function (list) {
    window.__tmsFavs = list || [];
    if (window.fsRerender) window.fsRerender();
  };

  /** Schreibt Text in das Terminal, das die Bottom-Bar gerade bedient. */
  function insertIntoTerminal(text, okMsg) {
    if (!text) return;
    var card = activeCardId();
    if (!card) { post('clipboard:write', { text: text }); toast('Kein Terminal — kopiert'); return; }
    var wrap = document.getElementById('toolSheetWrap');
    if (wrap && typeof window.closeSheet === 'function') window.closeSheet(wrap);
    var input = document.getElementById('dockInput');
    if (input && !input.disabled) {
      // Reihenfolge ist entscheidend: focus() merkt sich den Feldinhalt als
      // Referenz für die Differenz. Erst schreiben und dann fokussieren hieße:
      // die Differenz ist leer, der Pfad steht im Feld — kommt aber nie im
      // Terminal an und ist bei Enter einfach weg.
      input.focus();
      input.value = (input.value ? input.value + ' ' : '') + text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      window.__tmsInput(card, text);
    }
    // okMsg === null heißt bewusst „still" — der Aufrufer meldet selbst (siehe
    // uploadFinished), sonst stünden zwei Meldungen übereinander.
    if (okMsg !== null) toast(okMsg || 'Eingefügt');
  }
  window.__tmsInsert = insertIntoTerminal;

  // Snippets — tapping one writes it into the active terminal for real.
  var snipConfirmDel = null;
  window.buildSnippetsSheet = function () {
    var list = window.TMS_DATA.snippets || [];
    var addRow = '<div class="fx-head" style="margin-bottom:10px">' +
      '<input class="term-input fx-input" id="snipNew" placeholder="Neues Snippet…">' +
      '<button class="btn-chip" id="snipAdd">Hinzufügen</button></div>';
    var html = addRow + '<div class="tool-list">' + list.map(function (s) {
      return '<div class="fx-row">' +
        '<button class="tool-row is-tap" data-snippet="' + escapeHtml(s.id) + '">' +
        '<span class="tool-row__name">' + escapeHtml(s.label) + '</span>' +
        '<span class="tool-row__meta mono-text">' + escapeHtml(s.cmd) + '</span></button>' +
        '<button class="fx-more" data-snipdel="' + escapeHtml(s.id) + '" aria-label="Löschen">' +
          (snipConfirmDel === s.id ? '✕?' : '✕') + '</button></div>';
    }).join('') + (list.length ? '' : '<div class="tool-empty">Keine Snippets.</div>') + '</div>';
    return {
      html: html,
      wire: function () {
        var inp = document.getElementById('snipNew');
        document.getElementById('snipAdd').addEventListener('click', function () {
          if (inp.value.trim()) { post('snippet:add', { text: inp.value.trim() }); inp.value = ''; }
        });
        document.querySelectorAll('#toolSheetBody [data-snippet]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var sn = (window.TMS_DATA.snippets || []).find(function (x) { return x.id === btn.dataset.snippet; });
            if (sn) insertIntoTerminal(sn.cmd, 'In Terminal eingefügt');
          });
        });
        document.querySelectorAll('#toolSheetBody [data-snipdel]').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var id = btn.dataset.snipdel;
            if (snipConfirmDel !== id) {
              snipConfirmDel = id;
              btn.textContent = '✕?';
              setTimeout(function () { if (snipConfirmDel === id) { snipConfirmDel = null; btn.textContent = '✕'; } }, 3000);
            } else {
              snipConfirmDel = null;
              post('snippet:delete', { id: id });
            }
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

  // Leer ist leer — kein Sheet zeigt jemals einen Platzhalter aus der Demo.
  function withEmptyState(fn, key, msg) {
    return function () {
      var d = window.TMS_DATA[key];
      if (!d || !d.length) return { html: '<div class="tool-empty">' + msg + '</div>' };
      return fn();
    };
  }
  window.buildProcessesSheet = withEmptyState(window.buildProcessesSheet, 'processes', 'Lade Prozesse vom Server …');

  var watchConfirmDel = null;
  var origBuildWatchers = window.buildWatchersSheet;
  window.buildWatchersSheet = function () {
    var list = window.TMS_DATA.watchers || [];
    if (!list.length) return { html: '<div class="tool-empty">Keine Watcher angelegt.</div>' };
    var built = origBuildWatchers();
    return {
      html: built.html,
      wire: function () {
        document.querySelectorAll('#toolSheetBody [data-watcher]').forEach(function (row) {
          var input = row.querySelector('input[type="checkbox"]');
          if (input) input.addEventListener('change', function () {
            post('watcher:toggle', { id: row.dataset.watcher, on: input.checked });
          });
          var del = document.createElement('button');
          del.className = 'fx-more';
          del.textContent = '✕';
          del.setAttribute('aria-label', 'Watcher löschen');
          del.addEventListener('click', function (e) {
            e.stopPropagation();
            var id = row.dataset.watcher;
            if (watchConfirmDel !== id) {
              watchConfirmDel = id;
              del.textContent = '✕?';
              setTimeout(function () { if (watchConfirmDel === id) { watchConfirmDel = null; del.textContent = '✕'; } }, 3000);
            } else {
              watchConfirmDel = null;
              post('watcher:delete', { id: id });
            }
          });
          row.style.position = 'relative';
          row.appendChild(del);
        });
      },
    };
  };

  // Screenshots — the real workflow: grab an image, upload it to the server,
  // then drop its path into the terminal so the AI can actually look at it.
  var uploadState = null; // { done, total, frac } während des Hochladens
  var shotSelect = false; // von uploadFinished zurückgesetzt (Auswahlmodus entfernt)
  var shotSel = {};       // dito

  // Nur noch die zwei Wege: direkt Kamera oder Galerie-Multiselect. Kein
  // Archiv, keine Thumbnail-Historie, kein „Alle einfügen" — nach der Auswahl
  // fügt die RN-Seite die Serverpfade in die Eingabezeile ein und
  // uploadFinished schließt die Karte automatisch.
  window.buildScreenshotsSheet = function () {
    // Balken = fertige Dateien + Anteil der laufenden. Ein einzelnes Video von
    // 200 MB stünde sonst minutenlang auf „0 von 1" — das sähe wie ein Hänger aus.
    var progress = '';
    if (uploadState) {
      var total = Math.max(1, uploadState.total);
      var pct = Math.max(0, Math.min(100, Math.round(((uploadState.done + uploadState.frac) / total) * 100)));
      var nr = Math.min(uploadState.done + 1, total);
      var part = uploadState.frac > 0 ? ' · ' + Math.round(uploadState.frac * 100) + ' %' : '';
      progress = '<div class="up-progress"><div class="up-progress__bar"><span style="width:' + pct + '%"></span></div>' +
        '<div class="up-progress__label">Lade hoch … ' + nr + ' von ' + total + part + '</div></div>';
    }

    var choice = uploadState ? '' :
      '<div class="shot-choice">' +
      '<button class="shot-choice__btn" id="shotCaptureBtn">' + icon('camera', 22) + '<span>Kamera</span></button>' +
      '<button class="shot-choice__btn" id="shotPickBtn">' + icon('grid', 22) + '<span>Galerie</span><small>Fotos & Videos · bis 20</small></button>' +
      '</div>';

    return {
      html: progress + choice,
      wire: function () {
        var cap = document.getElementById('shotCaptureBtn');
        if (cap) cap.addEventListener('click', function () {
          var flash = document.getElementById('shotFlash');
          if (flash) { flash.classList.add('is-flashing'); setTimeout(function () { flash.classList.remove('is-flashing'); }, 160); }
          post('shot:capture', { source: 'camera', cardId: activeCardId() });
        });
        var pick = document.getElementById('shotPickBtn');
        if (pick) pick.addEventListener('click', function () { post('shot:capture', { source: 'library', cardId: activeCardId() }); });
      },
    };
  };

  /** Ladefortschritt: wie viele von wie vielen Dateien schon durch sind, und
   *  (bei Videos) welcher Anteil der laufenden Datei: frac 0..1. */
  window.TMSBridge.uploadProgress = function (done, total, srvId, frac) {
    uploadState = (done >= total) ? null
      : { done: done, total: total, frac: Math.max(0, Math.min(1, Number(frac) || 0)) };
    // NUR während des Uploads das offene Sheet mit Fortschritt neu bauen. Beim
    // Abschluss NICHT: setTool→openSheet würde das Sheet erneut öffnen und dabei
    // den Close-Timer canceln, den insertIntoTerminal/uploadFinished gleich
    // setzen — dann bliebe die Karte offen. uploadFinished schließt sie.
    if (uploadState) window.TMSBridge.setTool('screenshots', window.TMS_DATA.screenshots || []);
  };

  /**
   * Nach dem Hochladen: die Galerie NICHT wieder aufklappen. Die Pfade stehen
   * in dem Moment schon im Terminal — das Sheet wäre nur noch eine Ansicht, die
   * man erst wieder wegwischen muss. Also: Liste still nachführen, Sheet zu,
   * eine kurze Bestätigung. (setTool täte genau das Gegenteil: es baut das
   * offene Sheet neu auf.)
   */
  window.TMSBridge.uploadFinished = function (shots, msg) {
    window.TMS_DATA.screenshots = shots || [];
    uploadState = null;
    shotSelect = false;
    shotSel = {};
    // Bedingungslos schließen (kein !hidden-Guard): ein bereits geschlossenes
    // Sheet erneut zu schließen ist harmlos, aber falls es noch offen ist,
    // muss es JETZT zu — genau das war der Bug.
    var wrap = document.getElementById('toolSheetWrap');
    if (wrap && typeof window.closeSheet === 'function') window.closeSheet(wrap);
    if (msg) toast(msg);
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
    if (window.__bundOnTool) window.__bundOnTool(key, data);
    if (cwd) window.__tmsCwd = cwd;
    if (openTool === key) origOpenTool(key); // rebuild the open sheet in place
  };
  /** Nach einem Upload: den Serverpfad sofort ins Terminal schreiben. */
  window.TMSBridge.insertIntoTerminal = function (text, msg) { insertIntoTerminal(text, msg); };
  /** Bund: Zwischenablage-Verlauf vom Handy (mit Quelle + Anheften). */
  window.TMSBridge.setClips = function (list) { if (window.__bundSetClips) window.__bundSetClips(list || []); };
  window.__tmsActiveCardId = function () { return activeCardId(); };
  /** Upload fertig: Pfade in GENAU die Karte, von der aus gestartet wurde. Ist
   *  sie nicht mehr vorne, gehen sie direkt an ihre Eingabe (ohne Enter). */
  window.TMSBridge.insertIntoCard = function (cardId, text, msg) {
    if (!text) return;
    if (!cardId || !document.querySelector('.term-card[data-id="' + cardId + '"]') || cardId === activeCardId()) { insertIntoTerminal(text, msg); return; }
    if (typeof window.__tmsInput === 'function') window.__tmsInput(cardId, text);
    if (msg !== null) toast(msg || 'Eingefügt');
  };
  /**
   * Gebetszeiten in die Seite. `meta` ist optional: ohne sie verhaelt sich die
   * Seite exakt wie vorher (Liste + Countdown). Die Normalisierung liegt in
   * prayerBridge.js, damit sie ohne Fenster getestet werden kann.
   */
  window.TMSBridge.setPrayer = function (times, meta) {
    var p = normalizePrayerPayload(times, meta);
    window.TMS_DATA.prayerTimes = p.times;
    window.TMS_DATA.prayerMeta = p.meta;
    if (typeof window.renderPrayerList === 'function') window.renderPrayerList();
    // Kein renderPrayerScreen(): der 1-Sekunden-Ticker laeuft nur, solange der
    // Screen offen ist. setPrayer kommt auch im Hintergrund, alle paar Sekunden.
    if (typeof window.renderPrayerMeta === 'function') window.renderPrayerMeta();
    if (typeof window.renderAdhanSettings === 'function') window.renderAdhanSettings();
    if (typeof window.updateLatencyDisplay === 'function') window.updateLatencyDisplay();
  };

  /** Nur die Adhan-Einstellungen, ohne die Zeiten neu zu schicken. Wird nach
   *  jedem Schalter benutzt, damit der Schalter nicht zurueckkippt. */
  window.TMSBridge.setAdhanSettings = function (adhan) {
    var meta = window.TMS_DATA.prayerMeta;
    if (!meta) return;
    meta.adhan = {
      enabled: !!adhan.enabled,
      wecker: !!adhan.wecker,
      selected: String(adhan.selected || 'mishary'),
    };
    if (typeof window.renderAdhanSettings === 'function') window.renderAdhanSettings();
  };

  /** Nur die Berechtigungen — die kann der Nutzer jederzeit auf der Systemseite
   *  aendern, ohne dass wir neue Zeiten schicken muessen. */
  var normalizePerms = window.__tmsNormalizePerms || function (p) {
    return { notifications: !!p.notifications, exactAlarms: !!p.exactAlarms };
  };
  window.TMSBridge.setAdhanPerms = function (perms) {
    var meta = window.TMS_DATA.prayerMeta;
    if (!meta) return;
    meta.perms = Object.assign({}, meta.perms || {}, normalizePerms(perms || {}));
    if (typeof window.renderAdhanSettings === 'function') window.renderAdhanSettings();
  };
  /** Stand vom Handy: nächster geplanter Azān, Methode (automatisch), Erlaubnisse. */
  window.TMSBridge.setAdhanStatus = function (st) {
    var meta = window.TMS_DATA.prayerMeta;
    if (!meta || !st) return;
    if (st.perms) meta.perms = Object.assign({}, meta.perms || {}, normalizePerms(st.perms));
    if (st.method) meta.method = Object.assign({}, meta.method || {}, { name: String(st.method), auto: true, country: st.country || null });
    meta.next = st.nextAt ? { name: String(st.nextName || ''), at: Number(st.nextAt), exact: !!st.nextExact } : null;
    if (typeof window.renderAdhanSettings === 'function') window.renderAdhanSettings();
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

  // ══ Die Eingabezeile IST die des Terminals ═══════════════════════════════
  // Bisher ging der Text erst bei Enter raus — in Claudes eigener Eingabezeile
  // stand also nichts, während man tippte. Jetzt geht jedes Zeichen sofort an
  // die PTY. Gesendet wird die DIFFERENZ zum vorherigen Feldinhalt, nicht der
  // einzelne Tastendruck: damit kommt auch Androids Wortvorschlag korrekt an
  // (er ersetzt ganze Wörter — als Rückschritte plus neuer Text).
  var dockInput = document.getElementById('dockInput');
  var dockLast = '';
  var dockDrafts = Object.create(null);
  var dockLastTarget = window.dockTargetId && window.dockTargetId();

  function dockToPty() {
    var id = window.dockTargetId && window.dockTargetId();
    if (!id || !byCard[id]) { dockLast = dockInput.value; return; }
    var now = dockInput.value, prev = dockLast, i = 0;
    while (i < prev.length && i < now.length && prev[i] === now[i]) i++;
    var data = new Array(prev.length - i + 1).join('\x7f') + now.slice(i);
    dockLast = now;
    if (data) window.__tmsInput(id, data);
  }
  function dockReset(cardId) {
    var id = cardId || (window.dockTargetId && window.dockTargetId());
    if (id) delete dockDrafts[id];
    if (id && id !== (window.dockTargetId && window.dockTargetId())) return;
    dockInput.value = '';
    dockLast = '';
    if (typeof window.autoGrowInput === 'function') window.autoGrowInput(dockInput);
  }
  if (dockInput) {
    dockInput.addEventListener('input', dockToPty);
    dockInput.addEventListener('focus', function () { dockLast = dockInput.value; });
  }
  window.sendTerminalCommand = function (id, cmd) {
    if (!id) return;
    window.__tmsInput(id, '\r');
    dockReset(id);
  };
  var origHandleTermKey = window.handleTermKey;
  window.handleTermKey = function (key, id) {
    origHandleTermKey(key, id);
    if (key === 'ctrlc' || key === 'esc' || key === 'enter') dockReset(id);
  };
  var origSendCtrlC = window.sendCtrlC;
  window.sendCtrlC = function (id) { origSendCtrlC(id); dockReset(id); };

  // The PTY already contains the typed draft. Restore only the local field and
  // its sent-text baseline; replaying it would duplicate the shell input.
  var origSyncDock = window.syncDockTerminal;
  window.syncDockTerminal = function () {
    var id = window.dockTargetId && window.dockTargetId();
    if (id !== dockLastTarget) {
      if (dockLastTarget && (window.TMS_DATA.sessions || []).some(function (s) { return s.id === dockLastTarget; })) {
        dockDrafts[dockLastTarget] = { value: dockInput.value, sent: dockLast, start: dockInput.selectionStart, end: dockInput.selectionEnd };
      }
      dockLastTarget = id;
      var draft = id && dockDrafts[id];
      dockInput.value = draft ? draft.value : '';
      dockLast = draft ? draft.sent : '';
      if (draft) dockInput.setSelectionRange(draft.start, draft.end);
      if (typeof window.autoGrowInput === 'function') window.autoGrowInput(dockInput);
    }
    origSyncDock();
  };

  // Die Seite stimmt NIE selbst zu. Auto-Approve führt der Server aus — er kennt
  // die Prompt-Varianten ([y/N] braucht 'y', nicht Enter) und blockt bei
  // ungesendetem Text. Die alte Auto-Logik des Mockups hätte hier blind Enter
  // gedrückt und damit ein [y/N] ABGELEHNT — und sie öffnete zusätzlich das
  // Berechtigungsfenster, obwohl Auto-Approve genau das ersparen soll.
  window.autoApproveResolve = function () { /* der Server macht das */ };

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
      // Die sessionId MUSS mit: die Karten-ID ist nur fuer dieses eine Laden der
      // Seite gueltig (der Zaehler faengt bei jedem Start wieder bei t1 an),
      // waehrend der Reiter im Store seine ID von damals behaelt. Nach einem
      // Wiederherstellen zeigten beide auf verschiedene Terminals — die
      // Beschriftung landete auf dem falschen. Alle anderen Nachrichten tragen
      // die sessionId laengst mit (siehe autoapprove:set).
      post('terminal:rename', { cardId: session.id, sessionId: byCard[session.id], field: field, value: last });
    });
  };

  // ══ Einstellungen: settings.js (eine Seite für alles) ══

  // ══ Update-Banner ═════════════════════════════════════════════════════════
  var origRenderUpdateBanner = window.renderUpdateBanner;
  window.renderUpdateBanner = function (host) {
    if (window.__bundUpdateCard) { window.__bundUpdateCard(host); return; } // schlichte Karte (bund.js)
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

  // Tippt der Nutzer eine andere (laufende) Server-Karte an, schaltet React
  // Native die Verbindung um (Terminals des alten Servers weg, die des neuen rein).
  window.__tmsSwitchServer = function (id) { post('server:switch', { id: id }); };

  // Tippt der Nutzer den Fernzugriff-Knopf auf der Geraetekarte an: React
  // Native holt die Zugangsdaten und reicht sie ueber setRemoteTarget zurueck
  // (siehe weiter unten) — die Seite baut die Bildverbindung selbst auf.
  window.__tmsOpenRemote = function (id) {
    remoteWantId = id || null;
    // Ein liegengebliebenes „Beenden“ (Zugangsdaten kamen nie) darf das
    // Öffnen nicht in ein Schliessen verwandeln.
    if (id && typeof remoteClosing === 'object') delete remoteClosing[id];
    post('remote:open', { id: id });
  };

  // ══ React Native → WebView (Server, Update, Auto-Approve) ═════════════════
  /** Bund: Diktat gibt es nur, solange ein Gerät mit caps.dictation (der Mac)
   *  online ist — sonst ist der Mikro-Knopf weg (und kommt zurück). */
  window.TMSBridge.setDictationAvailable = function (on) {
    if (!document.getElementById('bundNoDictCss')) {
      var st = document.createElement('style');
      st.id = 'bundNoDictCss';
      st.textContent = 'body.no-dictation #dockMicBtn, body.no-dictation .term-mic-btn { display: none !important; }';
      document.head.appendChild(st);
    }
    document.body.classList.toggle('no-dictation', !on);
  };
  /** Bund: Tipp auf ein Gerät — es gibt nichts umzuschalten, nur zu den Terminals. */
  window.TMSBridge.goToTerminals = function () { if (typeof window.goToTerminals === 'function') window.goToTerminals(); };
  window.TMSBridge.setServers = function (servers) {
    // Die Latenz pflegt die Seite (setStatus / setServerLatency) — eine frische
    // Liste ohne Wert darf den letzten Ping nicht wegwischen.
    var prev = {};
    (window.TMS_DATA.servers || []).forEach(function (s) { prev[s.id] = s.latency; });
    servers.forEach(function (s) { if (s.latency == null && prev[s.id] != null) s.latency = prev[s.id]; });
    window.TMS_DATA.servers = servers;
    if (typeof window.renderServers === 'function') window.renderServers();
    if (typeof window.renderSettings === 'function') window.renderSettings();
    // Gerätenamen in Leiste/Kopfzeile erscheinen, sobald ein zweites Gerät da ist.
    if (typeof window.renderTermSwitcher === 'function') window.renderTermSwitcher();
    if (typeof window.updateLatencyDisplay === 'function') window.updateLatencyDisplay();
    if (window.__deskRender) window.__deskRender();
  };
  /** Ping der weiteren Geräte (der Hauptserver kommt über setStatus). */
  window.TMSBridge.setServerLatency = function (map) {
    (window.TMS_DATA.servers || []).forEach(function (s) {
      if (map && Object.prototype.hasOwnProperty.call(map, s.id)) s.latency = map[s.id];
    });
    if (typeof window.updateLatencyDisplay === 'function') window.updateLatencyDisplay();
    if (window.__deskRender) window.__deskRender();
  };
  /** Bund: Gerät vorne laut App (gilt, wenn kein Terminal vorne einem Gerät gehört). */
  window.TMSBridge.setActiveDevice = function (id) {
    window.__bundActiveDev = id || null;
    if (window.__deskRender) window.__deskRender();
  };
  /** Update-Stand von der App: none | available | downloading | ready | error. */
  window.TMSBridge.setUpdateState = function (st) {
    st = st || {};
    window.TMS_DATA.update = { current: st.current || '', latest: st.latest || st.current || '', notes: st.notes || '' };
    var wasNone = !window.__bundUpdateStateSeen || window.__bundUpdateStateSeen === 'none';
    window.__bundUpdateStateSeen = st.status;
    if (window.__bundUpdateState) window.__bundUpdateState(st);
    // Bund-Seite nur neu bauen, wenn die Karte erscheint/verschwindet (nicht bei jedem Fortschritt)
    if ((wasNone !== (st.status === 'none')) && typeof window.renderServers === 'function') window.renderServers();
  };
  window.TMSBridge.setUpdate = function (update) {
    window.TMS_DATA.update = update;
    if (typeof window.renderServers === 'function') window.renderServers();
    if (typeof window.renderSettings === 'function' &&
        window.TMS_DATA.servers && window.TMS_DATA.servers.length) window.renderSettings();
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
  // React Native reicht nur die Zugangsdaten durch — Bilddaten sieht es nie.
  //
  // C2: `show('remote')` und `TMSRemote.start()` laufen synchron direkt beim
  // Antippen des Fernzugriffs-Knopfs (siehe den Mockup-Aufruf), aber die
  // Zugangsdaten kommen erst ueber den Umweg durch React Native zurueck —
  // bei einem fremden Server zusaetzlich nach einem asynchronen
  // Speicher-Zugriff dort. connect() bricht darum beim ersten Druck immer
  // mit "Kein Server verbunden." ab, `ws` bleibt null, und ohne ein `onclose`
  // gibt es keinen Ausloeser fuer einen neuen Versuch — erst ein zweiter
  // Tastendruck (der TMSRemote.start() erneut aufruft) verbindet. Der Haken
  // unten holt das nach, sobald die Zugangsdaten tatsaechlich da sind.
  var remoteTarget = null;
  // Das Gerät, dessen Zugangsdaten gerade erwartet werden. Die Antworten von
  // React Native kommen asynchron (fremdes Gerät: erst nach einem Speicher-
  // Zugriff) — beim schnellen Wechsel MAC → WIN konnte die späte MAC-Antwort
  // nach der WIN-Antwort eintreffen, und der nächste Neuversuch verband dann
  // wieder mit dem Mac, während die Insel WIN zeigte.
  var remoteWantId = null;
  // ── Fernzugriffe laufen, bis der Nutzer sie schliesst ────────────────────
  // Bildschirmwechsel, Hintergrund, Netzabbruch, Geraetewechsel: die Sitzung
  // auf dem Rechner bleibt (Bildschirm aus, Ton am Handy …) — der Server haelt
  // sie, bis jemand "Schliessen" sagt. Welche Geraete gerade eine haben, merkt
  // sich das Handy hier (gruener Punkt in der Insel), ueber App-Neustarts hinweg.
  var remoteAlive = (function () {
    try { return JSON.parse(localStorage.getItem('tms-remote-alive') || '{}') || {}; } catch (e) { return {}; }
  })();
  var remoteClosing = {};
  function setRemoteAlive(id, on) {
    if (!id || !!remoteAlive[id] === !!on) return;
    if (on) remoteAlive[id] = true; else delete remoteAlive[id];
    try { localStorage.setItem('tms-remote-alive', JSON.stringify(remoteAlive)); } catch (e) {}
    renderRemoteAlive();
  }
  function renderRemoteAlive() {
    if (document.body) document.body.classList.toggle('remote-alive', Object.keys(remoteAlive).length > 0);
    if (typeof window.__renderRemoteAlive === 'function') window.__renderRemoteAlive();
  }
  window.__remoteAliveIds = function () { return Object.keys(remoteAlive); };
  window.__setRemoteAlive = setRemoteAlive;
  /** Sitzung eines Geraets schliessen, zu dem gerade keine Bildverbindung
   *  steht: kurz verbinden, remote:stop, fertig (der Server beendet dann die
   *  ruhende Sitzung). Unerreichbar = der Punkt bleibt, spaeter erneut. */
  function devName(id) {
    var d = (window.TMS_DATA.servers || []).filter(function (x) { return x.id === id; })[0];
    return d ? d.name : 'dem Gerät';
  }
  /** Erst wenn der Rechner remote:stopped schickt, gilt die Sitzung als
   *  beendet. Vorher hiess es nach 0,8 s blind „beendet“ — auch wenn der
   *  Rechner das Stopp gar nicht umgesetzt hatte. */
  var CLOSE_CONFIRM_MS = function () { return window.__tmsCloseConfirmMs || 6000; };
  function closeRemoteVia(t) {
    var s, finished = false, timer = 0;
    var toast = function (m) { if (typeof window.toast === 'function') window.toast(m); };
    var finish = function (ok) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { s && s.close(); } catch (e) {}
      if (ok) { setRemoteAlive(t.id, false); toast('Fernzugriff auf ' + devName(t.id) + ' beendet'); }
      else { setRemoteAlive(t.id, true); toast(devName(t.id) + ' nicht erreichbar — der Fernzugriff läuft dort evtl. weiter. Bitte später erneut beenden.'); }
    };
    try { s = new WebSocket('ws://' + t.host + ':' + t.port + '/remote?token=' + encodeURIComponent(t.token)); }
    catch (e) { finish(false); return; }
    timer = setTimeout(function () { finish(false); }, CLOSE_CONFIRM_MS());
    s.onopen = function () { try { s.send(JSON.stringify({ type: 'remote:stop' })); } catch (e) { finish(false); } };
    s.onmessage = function (e) { if (typeof e.data === 'string' && e.data.indexOf('remote:stopped') >= 0) finish(true); };
    s.onerror = function () { finish(false); };
    s.onclose = function () { finish(false); }; // zu, bevor der Rechner bestätigt hat
  }
  window.__closeRemoteDevice = function (id) {
    if (!id) return;
    remoteClosing[id] = true;
    post('remote:open', { id: id, closing: true });
  };
  setTimeout(renderRemoteAlive, 0);

  window.TMSBridge.setRemoteTarget = function (t) {
    if (t && t.id && remoteClosing[t.id]) { delete remoteClosing[t.id]; closeRemoteVia(t); return; }
    if (t && t.id && remoteWantId && t.id !== remoteWantId) return;
    remoteTarget = t;
    if (typeof window.__tmsRemoteTargetReady === 'function') window.__tmsRemoteTargetReady();
  };

  // ── Dateien Handy ⇄ Rechner ─────────────────────────────────────────────
  // Senden: die Seite laedt die gewaehlten Dateien selbst hoch (XHR, mit
  // Fortschritt) — POST /files/upload, rohe Datei als Rumpf. Ohne
  // Content-Type und mit ?token=, damit keine CORS-Vorabfrage noetig ist.
  // Nacheinander, damit ein grosses Video nicht alle anderen ausbremst.
  // Chromium sperrt Anfragen der App-Seite (https://tms.local) ins lokale
  // Netz — Tailscale 100.x zaehlt dazu. <img>/<video>/<iframe>/XHR an den
  // Rechner scheitern deshalb in der App; nativ (React Native) geht alles.
  // Darum laufen Upload und Vorschau-Inhalte ueber die App.
  var netReqs = {}, netSeq = 0;
  function viaApp(type, payload, cb) {
    var id = 'n' + (++netSeq) + '-' + Date.now().toString(36);
    netReqs[id] = cb;
    payload.reqId = id;
    post(type, payload);
    return id;
  }
  /** Antwort der App auf viaApp (mehrfach moeglich, z. B. Fortschritt). */
  window.TMSBridge.netReply = function (id, data) {
    var cb = netReqs[id];
    if (!cb) return;
    if (!data || !data.progress) delete netReqs[id];
    cb(data || {});
  };
  var UP_CHUNK = 3 * 1024 * 1024; // roh; als Base64 ≈ 4 MB pro Nachricht
  function readChunkB64(blob, cb) {
    var r = new FileReader();
    r.onload = function () { var s = String(r.result || ''); cb(null, s.slice(s.indexOf(',') + 1)); };
    r.onerror = function () { cb('Datei nicht lesbar'); };
    r.readAsDataURL(blob);
  }
  function uploadFiles(base, token, files, dir, reveal, onProgress, onDone) {
    if (window.ReactNativeWebView) return uploadFilesViaApp(base, token, files, dir, reveal, onProgress, onDone);
    return uploadFilesXhr(base, token, files, dir, reveal, onProgress, onDone);
  }
  function uploadFilesViaApp(base, token, files, dir, reveal, onProgress, onDone) {
    var list = Array.prototype.slice.call(files || []);
    var total = list.reduce(function (n, f) { return n + (f.size || 0); }, 0) || 1;
    var sent = 0, saved = [], i = 0;
    function nextFile() {
      if (i >= list.length) { onDone(null, saved); return; }
      var f = list[i++], last = i === list.length;
      var up = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      var parts = Math.max(1, Math.ceil((f.size || 0) / UP_CHUNK)), part = 0;
      function nextPart() {
        var start = part * UP_CHUNK, blob = f.slice(start, Math.min(f.size, start + UP_CHUNK));
        readChunkB64(blob, function (err, b64) {
          if (err) { onDone(err, saved); return; }
          viaApp('files:uploadPart', {
            base: base, token: token, dir: dir, name: f.name || 'datei', up: up, part: part,
            final: part === parts - 1, reveal: !!(reveal && last), b64: b64,
          }, function (res) {
            if (res.error) { onDone(res.status === 404 ? 'Server zu alt — am Rechner „tms-terminal update“ ausführen' : res.error, saved); return; }
            sent += blob.size;
            if (onProgress) onProgress(Math.min(1, sent / total), f.name);
            part++;
            if (part < parts) nextPart();
            else { saved.push(res.result || { name: f.name }); nextFile(); }
          });
        });
      }
      nextPart();
    }
    nextFile();
  }
  /** Vorschau-Inhalt ueber die App: Bild als data:-URL, Video/PDF im Android-Betrachter. */
  window.fsLoadPreview = function (path, kind, cb) {
    if (!window.ReactNativeWebView) { var u = window.fsFileUrl(path); setTimeout(function () { cb({ src: u }); }, 0); return; }
    viaApp('files:fetchPreview', { path: path, kind: kind }, cb);
  };
  function uploadFilesXhr(base, token, files, dir, reveal, onProgress, onDone) {
    var list = Array.prototype.slice.call(files || []);
    var total = list.reduce(function (n, f) { return n + (f.size || 0); }, 0) || 1;
    var sent = 0, saved = [], i = 0;
    function next() {
      if (i >= list.length) { onDone(null, saved); return; }
      var f = list[i++];
      var url = base + '/files/upload?dir=' + encodeURIComponent(dir) + '&name=' + encodeURIComponent(f.name || 'datei')
        + (reveal && i === list.length ? '&reveal=1' : '') + '&token=' + encodeURIComponent(token);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.upload.onprogress = function (e) { if (onProgress) onProgress(Math.min(1, (sent + (e.loaded || 0)) / total), f.name); };
      xhr.onload = function () {
        var d = {};
        try { d = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
        if (xhr.status === 404) { onDone('Server zu alt — am Rechner „tms-terminal update“ ausführen', saved); return; }
        if (xhr.status !== 200) { onDone(d.error || ('HTTP ' + xhr.status), saved); return; }
        sent += f.size || 0;
        saved.push(d);
        next();
      };
      xhr.onerror = function () { onDone('Verbindung abgebrochen', saved); };
      // Leerer Typ: sonst setzt der Browser den MIME-Typ als Content-Type (→ Vorabfrage).
      xhr.send(f.slice(0, f.size, ''));
    }
    next();
  }
  /** Fernzugriff → an das gerade gezeigte Geraet (Standard: Downloads › TMS, im Finder zeigen). */
  window.rxUpload = function (files, dir, onProgress, onDone) {
    if (!remoteTarget || !remoteTarget.host) { onDone('Kein Gerät verbunden', []); return; }
    uploadFiles('http://' + remoteTarget.host + ':' + remoteTarget.port, remoteTarget.token, files, dir || '~/Downloads/TMS', true, onProgress, onDone);
  };
  /** Explorer → in den gerade offenen Ordner. */
  window.fsUpload = function (files, dir, onProgress, onDone) {
    if (!fsBase) { onDone('Kein Gerät verbunden', []); return; }
    uploadFiles(fsBase, fsToken, files, dir, false, onProgress, onDone);
  };
  // Holen: Explorer auf DEM Geraet an DIESEM Ordner — RN stellt das Geraet um
  // und listet, die Seite zeigt den Explorer schon mal (ohne beim alten Geraet zu listen).
  window.rxOpenFilesOn = function (id, path) {
    if (typeof window.__bundOpenFilesOn === 'function') window.__bundOpenFilesOn(id, path || '~');
    else if (typeof window.fsShowAt === 'function') window.fsShowAt(path || '~', true);
    post('files:openOn', { id: id, path: path || '~' });
  };

  document.addEventListener('pointerdown', function (e) {
    if (e.target.closest && e.target.closest('.term-card')) {
      setTimeout(function () {
        if (typeof window.syncDockTerminal === 'function') window.syncDockTerminal();
      }, 0);
    }
  }, true);

  // ── Terminal beenden — echt, nicht nur die Karte ──────────────────────────
  // Die Karte fällt erst, wenn der Server das Ende bestätigt; eine Session, die
  // nie angehängt wurde, wird nur weggeräumt.
  window.closeTerminal = function (cardId) {
    var sid = byCard[cardId];
    if (!sid) {
      delete bound[cardId];
      delete byCard[cardId];
      if (terms[cardId]) { try { terms[cardId].term.dispose(); terms[cardId].box.remove(); } catch (e) {} delete terms[cardId]; }
      if (typeof window.removeTerminalCard === 'function') window.removeTerminalCard(cardId);
      return;
    }
    post('terminal:close', { cardId: cardId, sessionId: sid });
    if (typeof window.toast === 'function') window.toast('Beende…');
  };
  /**
   * Die gespeicherte Session existiert auf dem Server nicht mehr ("Session not
   * found"). Vorher blieb die Karte dann für immer leer — jetzt heilt sie sich:
   * dieselbe Karte, derselbe Name, eine frische PTY.
   */
  window.TMSBridge.sessionExpired = function (sessionId) {
    var cardId = cardOf(sessionId);
    if (!cardId) return;
    dockReset(cardId);
    delete byCard[cardId];
    bound[cardId] = 'pending';
    var t = terms[cardId];
    if (t) { try { t.term.reset(); } catch (e) {} invalidateRowCache(cardId); renderTerm(cardId); }
    if (typeof window.toast === 'function') window.toast('Session abgelaufen — starte neu');
    var d = dims(cardId);
    var sessName = (window.TMS_DATA.sessions || []).find(function (x) { return x.id === cardId; });
    post('terminal:create', { cardId: cardId, cols: d.cols, rows: d.rows, name: sessName ? sessName.name : undefined, serverId: (sessName && sessName.server) || undefined });
  };
  /**
   * Nach einem Verbindungsabriss hängt der Server die Sessions ab und puffert
   * ihren Output. Ohne erneutes Anhängen bleibt jede Karte beim letzten Frame
   * stehen — während der Kopf fröhlich "Verbunden" zeigt (der WebSocket selbst
   * ist ja wieder da). Hier hängen wir alle gebundenen Karten neu an; der
   * Server flusht dann alles Verpasste in einem Rutsch.
   */
  window.TMSBridge.reattachAll = function () {
    Object.keys(byCard).forEach(function (cardId) {
      var sid = byCard[cardId];
      if (!sid) return;
      var d = dims(cardId);
      lastDims[sid] = d.cols + 'x' + d.rows;
      post('terminal:attach', { cardId: cardId, sessionId: sid, cols: d.cols, rows: d.rows, fresh: isFresh(cardId) });
    });
  };
  /** Der Server konnte für diese Karte keine PTY anlegen. Ohne das hier bliebe
   *  sie als Geisterkarte stehen: leer, nie gebunden, beim nächsten
   *  Wiederherstellen spurlos verschwunden. Weg damit — den Grund sagt der Toast. */
  window.TMSBridge.sessionCreateFailed = function (cardId) {
    dockReset(cardId);
    delete bound[cardId];
    delete byCard[cardId];
    if (terms[cardId]) { try { terms[cardId].term.dispose(); terms[cardId].box.remove(); } catch (e) {} delete terms[cardId]; }
    if (typeof window.removeTerminalCard === 'function') window.removeTerminalCard(cardId);
  };

  window.TMSBridge.sessionClosed = function (sessionId) {
    var cardId = cardOf(sessionId);
    if (!cardId) return;
    dockReset(cardId);
    delete bound[cardId];
    delete byCard[cardId];
    if (terms[cardId]) { try { terms[cardId].term.dispose(); terms[cardId].box.remove(); } catch (e) {} delete terms[cardId]; }
    if (typeof window.removeTerminalCard === 'function') window.removeTerminalCard(cardId);
    if (typeof window.toast === 'function') window.toast('Terminal beendet');
  };

  /** Beim Server-Wechsel: alle Karten des alten Servers abräumen, ohne die PTYs
   *  zu schließen (die laufen auf dem Server weiter). Danach bestückt
   *  restoreSessions die Seite mit den Terminals des neuen Servers. */
  window.TMSBridge.clearAllTerminals = function () {
    dockDrafts = Object.create(null);
    dockLastTarget = null;
    dockReset();
    Object.keys(terms).forEach(function (cardId) {
      try { terms[cardId].term.dispose(); terms[cardId].box.remove(); } catch (e) {}
      delete terms[cardId];
    });
    Object.keys(bound).forEach(function (k) { delete bound[k]; });
    Object.keys(byCard).forEach(function (k) { delete byCard[k]; });
    (window.TMS_DATA.sessions || []).slice().forEach(function (s) {
      if (typeof window.removeTerminalCard === 'function') window.removeTerminalCard(s.id);
    });
    if (typeof window.syncDockTerminal === 'function') window.syncDockTerminal();
    if (typeof window.renderTermSwitcher === 'function') window.renderTermSwitcher();
  };

  // ── Kein Flackern in der Übersicht ────────────────────────────────────────
  // Das Original baute bei JEDEM Statuswechsel Rail und Übersichtsraster komplett
  // neu — bei laufendem Output flackerte die ganze Anzeige. Jetzt werden nur die
  // sichtbaren Chips und Vorschauen in place aktualisiert; das Raster selbst
  // bauen weiterhin nur Öffnen/Schließen und Struktur-Änderungen.
  window.refreshPreviews = function () {
    document.querySelectorAll('.overview-tile[data-id]').forEach(function (tile) {
      var id = tile.getAttribute('data-id');
      var sess = (window.TMS_DATA.sessions || []).find(function (x) { return x.id === id; });
      var chip = tile.querySelector('.status-chip');
      if (chip && sess) chip.dataset.status = sess.status;
      var body = tile.querySelector('.overview-tile__body');
      if (body && window.__tmsPreview) body.innerHTML = window.__tmsPreview(id, 5);
    });
    document.querySelectorAll('.rail-item[data-id]').forEach(function (item) {
      var prev = item.querySelector('.rail-item__preview');
      if (prev && window.__tmsPreview) prev.innerHTML = window.__tmsPreview(item.getAttribute('data-id'), 2);
    });
    if (window.__deskRender) window.__deskRender(); // Bund-Seitenleiste: LÄUFT/FRAGE/…
  };

  // ── Multiple-Choice-Rückfragen: die Antwort erreicht die PTY wirklich ─────
  // Das Mockup echote die Auswahl nur lokal (sim.respond() ohne Argument = nur
  // Enter). Ein echtes Menü von Claude Code will die ZIFFER der Option — bei
  // Mehrfachauswahl Ziffer + Leertaste je Option, dann Enter.
  window.submitQuestionAnswer = function () {
    var st = window.__tmsState;
    var id = st && st.pendingPromptId;
    if (!id) return;
    var cs = window.__tmsCardState && window.__tmsCardState[id];
    var data = cs && cs.pendingPrompt;
    if (!data) return;
    var optionsEl = document.getElementById('questionOptions');
    var checked = Array.prototype.slice.call(optionsEl.querySelectorAll('input:checked'));
    if (!checked.length) return;
    var comment = (document.getElementById('questionComment').value || '').trim();

    var keys = '';
    if (data.multiSelect) {
      checked.forEach(function (inp) { keys += inp.value + ' '; });
      keys += '\r';
    } else {
      keys = checked[0].value; // Einzelauswahl: die Ziffer wählt UND bestätigt
    }
    window.__tmsInput(id, keys);
    // Eine Anmerkung kann das TUI-Menü nicht aufnehmen — sie geht als
    // Folgezeile hinterher, sobald das Menü die Auswahl verarbeitet hat.
    if (comment) setTimeout(function () { window.__tmsInput(id, comment + '\r'); }, 400);

    cs.pendingPrompt = null;
    st.pendingPromptId = null;
    window.closeSheet(document.getElementById('questionSheetWrap'));
    if (typeof window.updatePendingBadge === 'function') window.updatePendingBadge();
    if (typeof window.setIslandActivity === 'function') window.setIslandActivity('live', 'Claude arbeitet');
  };

  // ── Manager: Agenda & Einträge echt ───────────────────────────────────────
  // Der Server ist die Wahrheit; die Demo-Daten aus data.js werden ersetzt,
  // sobald die erste Antwort da ist.
  window.TMSBridge.setAgenda = function (items) {
    window.TMS_DATA.manager.agenda = items || [];
    if (typeof window.renderManagerAgenda === 'function') window.renderManagerAgenda();
  };
  window.TMSBridge.setEntries = function (entries) {
    window.TMS_DATA.manager.entries = entries || [];
    if (typeof window.renderManagerEntries === 'function') window.renderManagerEntries();
  };
  // Proaktiver Kanal: Ungelesen-Zahl auf der Insel + Nachricht in den Chat.
  window.TMSBridge.setUnread = function (n) {
    if (typeof window.applyManagerUnread === 'function') window.applyManagerUnread(n);
  };
  window.TMSBridge.proactive = function (msg) {
    if (typeof window.applyManagerProactive === 'function') window.applyManagerProactive(msg);
  };
  window.managerOutboxRead = function () { post('manager:outboxRead', {}); };

  window.managerAgendaList = function () { post('manager:agendaList', {}); };
  window.managerEntriesList = function () { post('manager:entriesList', {}); };
  window.managerEntryToggle = function (id, done) { post('manager:entryToggle', { id: id, done: done }); };

  // ── Manager: Memory & Artifacts echt ──────────────────────────────────────
  window.TMSBridge.setManagerMemory = function (items) {
    window.TMS_DATA.manager.memory = items || [];
    if (typeof window.renderManagerMemory === 'function') window.renderManagerMemory();
  };
  window.TMSBridge.setManagerArtifacts = function (items) {
    window.TMS_DATA.manager.artifacts = items || [];
    if (typeof window.renderManagerArtifacts === 'function') window.renderManagerArtifacts();
    var host = document.getElementById('managerArtifacts');
    if (!host) return;
    // Antippen öffnet das Artefakt im In-App-Browser.
    Array.prototype.forEach.call(host.querySelectorAll('.artifact-card'), function (card, i) {
      var item = (window.TMS_DATA.manager.artifacts || [])[i];
      if (item && item.url) card.addEventListener('click', function () {
        window.TMSBridge.openBrowser(item.url);
      });
    });
  };

  // ══ Fernzugriff ═══════════════════════════════════════════════════════
  // Eigene WebSocket-Verbindung, direkt aus der Seite heraus. Der Umweg ueber
  // React Native scheidet aus: dessen Bruecke kann nur Text, Video muesste also
  // base64-kodiert werden — ein Drittel mehr Daten, 30-mal pro Sekunde.
  (function () {
    var ws = null;
    var decoder = null;
    var canvas = null;
    var ctx = null;
    var retry = 0;
    var retryTimer = null;
    var wantRunning = false;
    // Ton vom Rechner soll auch bei ausgeschaltetem Bildschirm weiterlaufen:
    // nur DANN hält die App das Handy wach (ConnectionService.setKeepAwake) —
    // früher hielt sie es immer wach, sobald „Hintergrund-Verbindung" an war.
    var soundAwake = false;
    function reportSound() {
      var on = !!wantRunning && !!(remoteOpts && remoteOpts.audio);
      if (on === soundAwake) return;
      soundAwake = on;
      post('remote:sound', { on: on });
    }
    // N1 (Nachpruefung): waehrend einer Hintergrund-Unterbrechung (suspend())
    // muss der normale Wiederverbindungs-Weg in onclose() stillliegen — sonst
    // sieht der ohnehin noch anhaengende onclose nach dem Schliessen
    // `wantRunning === true` (das bleibt bei suspend() bewusst unangetastet,
    // siehe TMSRemote.suspend() weiter unten) und plant selbst einen
    // Wiederverbindungs-Zeitgeber. Kommt die App dann zurueck, ruft resume()
    // sofort connect() UND der nachlaufende Zeitgeber ruft kurz danach ein
    // zweites — zwei offene Verbindungen, zwei Sitzungen auf dem PC, von
    // denen stop() nur noch die aktuelle erreicht.
    var suspended = false;
    var preset = 'auto';
    /** Qualitaet je Geraet — eine ruhende Sitzung wird nur mit denselben
     *  Wuenschen uebernommen (sonst startet der Rechner neu). */
    var presetByDev = {};
    function curDev() { return (remoteTarget && remoteTarget.id) || remoteWantId || null; }
    // Ueberlebt den Neuaufbau der Buehne (siehe buildRemoteScreen-Einklinkung
    // weiter unten) — sonst zeigt die frische Leiste kurz "Verbinde …", obwohl
    // die Verbindung laengst steht oder gerade an einem echten Fehler haengt.
    var lastVeil = '';
    var lastStat = '';

    var PRESETS = {
      sparsam: { maxWidth: 1280, fps: 24, bitrateKbps: 800 },
      auto:    { maxWidth: 1600, fps: 30, bitrateKbps: 1500 },
      scharf:  { maxWidth: 1920, fps: 30, bitrateKbps: 3000 },
      dex:     { maxWidth: 2048, maxHeight: 1536, fps: 60, bitrateKbps: 6000, dpi: 220, mode: 'dex' },
    };

    /**
     * Berechnet aus der echten iPad-Fenstergroesse eine durch 16 teilbare
     * DeX-Aufloesung im exakten Seitenverhaeltnis des Bildschirms (z. B. 4:3 ->
     * 2048x1536 statt 1920x1080), damit Samsung DeX auf dem iPad ohne schwarze
     * Balken im Vollbild laeuft.
     */
    function computeDeXViewportSpec(vw, vh, dpr) {
      var wCss = Math.max(Number(vw) || 1024, Number(vh) || 768);
      var hCss = Math.min(Number(vw) || 1024, Number(vh) || 768);
      var aspect = wCss / Math.max(1, hCss);
      var targetW = 2048;
      var targetH = Math.round((targetW / aspect) / 16) * 16;
      targetH = Math.max(1024, Math.min(1600, targetH));
      var dpi = Math.round(Math.max(180, Math.min(264, 110 * (Number(dpr) || 2))));
      return {
        maxWidth: targetW,
        maxHeight: targetH,
        dpi: dpi,
        fps: 60,
        bitrateKbps: 6000,
        mode: 'dex',
        localCursor: true,
        audio: true,
        audioCodec: 'pcm',
      };
    }
    window.computeDeXViewportSpec = computeDeXViewportSpec;

    /** Die App zeichnet den Zeiger selbst (siehe "Lokaler Zeiger" unten) —
     *  der Server laesst ihn dafuer aus dem Video weg, wo er das kann. */
    function startPayload() {
      if (preset === 'dex' || (remoteTarget && remoteTarget.mode === 'dex')) {
        var split = (window.remoteState && window.remoteState.dexSplitHeight) || 0;
        // Full monitor: the screen's real shape (iPad 4:3), not the momentary viewport — the
        // session starts before the status bar / safe-area padding are gone, which gave 2048x1472
        // and black side bars.
        if (!split && window.screen && window.screen.width && window.screen.height) {
          return computeDeXViewportSpec(window.screen.width, window.screen.height, window.devicePixelRatio || 2);
        }
        var availH = (window.innerHeight || 768) - split;
        return computeDeXViewportSpec(window.innerWidth || 1024, Math.max(320, availH), window.devicePixelRatio || 2);
      }
      var p = { localCursor: true, audio: !!remoteOpts.audio, curtain: !!remoteOpts.curtain };
      var chosen = PRESETS[preset] || PRESETS.auto;
      for (var k in chosen) p[k] = chosen[k];
      return p;
    }

    // ── Ton aufs Handy / Bildschirm verdunkeln ─────────────────────────────
    // Zwei Schalter im Fernzugriff-Menue, pro Handy gemerkt, fuer jedes Geraet
    // gleich. Sie wirken beim Sitzungsstart — Umschalten startet die Sitzung
    // neu (wie die Qualitaetsstufe).
    var remoteOpts = (function () {
      try { return JSON.parse(localStorage.getItem('tms-remote-opts') || '{}') || {}; } catch (e) { return {}; }
    })();
    function saveRemoteOpts() {
      try { localStorage.setItem('tms-remote-opts', JSON.stringify(remoteOpts)); } catch (e) {}
    }
    function renderRemoteOpts() {
      ['audio', 'curtain'].forEach(function (k) {
        var b = document.querySelector('.remote-opt[data-opt="' + k + '"]');
        if (b) b.classList.toggle('on', !!remoteOpts[k]);
      });
    }

    // Wiedergabe: Opus-Pakete (0x02) → WebCodecs-AudioDecoder → Web Audio,
    // mit kleinem Polster gegen Netz-Zacken. Wird das Polster zu gross
    // (Rueckstau), wird neu angesetzt statt den Ton immer spaeter zu spielen.
    var sound = { ctx: null, dec: null, next: 0 };
    function soundCtx() {
      // iOS: Web Audio defaults to the 'ambient' session, which the iPad's silent mode mutes
      // completely (packets played, nothing audible). 'playback' = media, like a video.
      try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (e) {}
      if (!sound.ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { sound.ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 }); }
        catch (e) { try { sound.ctx = new AC(); } catch (e2) { return null; } }
      }
      if (sound.ctx.state === 'suspended') { try { sound.ctx.resume(); } catch (e) {} }
      return sound.ctx;
    }
    // Android gibt Ton erst nach einer Beruehrung frei — jede Beruehrung im
    // Fernzugriff weckt den Ton-Ausgang, falls er noch schlaeft.
    document.addEventListener('pointerdown', function () {
      if (soundWanted() && wantRunning) soundCtx();
    }, true);
    // DeX cable monitor: the iPad IS the Fold's screen, so its sound belongs on the iPad too.
    function soundWanted() { return !!remoteOpts.audio || !!(window.remoteState && window.remoteState.dexMode); }
    // iOS only unlocks Web Audio on a completed gesture (touchend/click/keyup), not on
    // pointerdown/touchstart — without these the context stayed 'suspended' forever.
    ['touchend', 'pointerup', 'click', 'keyup'].forEach(function (evName) {
      document.addEventListener(evName, function () { if (soundWanted() && wantRunning) soundCtx(); }, true);
    });
    var pcmStats = { packets: 0, played: 0 };
    // DeX diagnostics: the iPad can't be inspected from the Mac, so report the sound state to
    // the Fold server, which writes it to its log.
    setInterval(function () {
      if (!window.remoteState || !window.remoteState.dexMode || !ws || ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({ type: 'remote:diag', payload: {
          ctx: sound.ctx ? sound.ctx.state : 'none',
          rate: sound.ctx ? sound.ctx.sampleRate : 0,
          t: sound.ctx ? Math.round(sound.ctx.currentTime * 100) / 100 : 0,
          next: Math.round((sound.next || 0) * 100) / 100,
          pcm: pcmStats.packets, played: pcmStats.played,
          want: soundWanted(), run: !!wantRunning,
          AD: typeof AudioDecoder !== 'undefined',
          session: navigator.audioSession ? navigator.audioSession.type : 'n/a',
        } }));
      } catch (e) {}
    }, 30000);
    function soundReset() {
      if (sound.dec) { try { sound.dec.close(); } catch (e) {} }
      sound.dec = null;
      sound.next = 0;
    }
    function playSound(data) {
      var ctx = sound.ctx;
      if (!ctx || !soundWanted()) { data.close(); return; }
      var n = data.numberOfFrames, ch = Math.min(2, data.numberOfChannels);
      var buf = ctx.createBuffer(ch, n, data.sampleRate);
      try {
        for (var c = 0; c < ch; c++) {
          var plane = new Float32Array(n);
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          buf.copyToChannel(plane, c);
        }
      } catch (e) {
        // Aeltere WebViews: nur das eigene Format kopierbar (verschachtelt).
        var all = new Float32Array(n * data.numberOfChannels);
        try { data.copyTo(all, { planeIndex: 0 }); } catch (e2) { data.close(); return; }
        for (var c2 = 0; c2 < ch; c2++) {
          var p2 = new Float32Array(n);
          for (var i = 0; i < n; i++) p2[i] = all[i * data.numberOfChannels + c2];
          buf.copyToChannel(p2, c2);
        }
      }
      data.close();
      var now = ctx.currentTime;
      if (sound.next < now + 0.02 || sound.next > now + 0.35) sound.next = now + 0.08;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(sound.next);
      sound.next += buf.duration;
    }
    /** DeX cable monitor: raw PCM (0x03, ts, s16le stereo 48 kHz) — iOS WKWebView has no
     *  WebCodecs AudioDecoder for Opus, so the Fold sends uncompressed audio over the cable. */
    function onPcmPacket(view) {
      pcmStats.packets++;
      if (!soundWanted()) return;
      var ctx = soundCtx();
      if (!ctx) return;
      pcmStats.played++;
      var bytes = view.length - 5;
      var frames = bytes >> 2;
      if (frames <= 0) return;
      var dv = new DataView(view.buffer, view.byteOffset + 5, frames * 4);
      var buf = ctx.createBuffer(2, frames, 48000);
      var l = buf.getChannelData(0), r = buf.getChannelData(1);
      for (var i = 0; i < frames; i++) {
        l[i] = dv.getInt16(i * 4, true) / 32768;
        r[i] = dv.getInt16(i * 4 + 2, true) / 32768;
      }
      var now = ctx.currentTime;
      if (sound.next < now + 0.02 || sound.next > now + 0.35) sound.next = now + 0.08;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(sound.next);
      sound.next += buf.duration;
    }
    function onSoundPacket(view) {
      if (!soundWanted() || !soundCtx()) return;
      if (!sound.dec || sound.dec.state === 'closed') {
        if (typeof AudioDecoder === 'undefined') return;
        sound.dec = new AudioDecoder({
          output: playSound,
          error: function () { soundReset(); },
        });
        sound.dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
      }
      var ts = (view[1] << 24 | view[2] << 16 | view[3] << 8 | view[4]) >>> 0;
      try {
        sound.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts * 1000, data: view.subarray(5) }));
      } catch (e) { soundReset(); }
    }

    function remoteVisible() {
      return !!document.querySelector('section[data-screen="remote"]:not([hidden])');
    }
    /** Was der Rechner wirklich macht, nach dem Start sagen — ein Wunsch ist
     *  kein Versprechen. Einmal pro Geraet und Inhalt, und nur im Fernzugriff:
     *  jede Wiederverbindung wiederholte die Meldung, auch im Terminal. */
    var optsReported = {};
    function reportRemoteOpts(p) {
      if (!remoteVisible()) return;
      var miss = [];
      if (remoteOpts.audio && p.audio !== true) miss.push('Ton');
      if (remoteOpts.curtain && p.curtain !== true) miss.push('Verdunkeln');
      if (!miss.length || typeof window.toast !== 'function') return;
      var old = p.audio === undefined && p.curtain === undefined;
      var key = (remoteTarget ? remoteTarget.host + ':' + remoteTarget.port : '?') + '|' + miss.join('+') + '|' + old;
      if (optsReported[key]) return;
      optsReported[key] = true;
      window.toast(miss.join(' + ') + (old
        ? ': Server auf dem Gerät zu alt — dort einmal tms-terminal update'
        : ' auf diesem Gerät nicht verfügbar'));
    }

    function veil(text) {
      lastVeil = text || '';
      var v = document.getElementById('remoteVeil');
      var t = document.getElementById('remoteVeilText');
      if (!v || !t) return;
      if (text) { t.textContent = text; v.dataset.show = '1'; }
      else { v.dataset.show = '0'; }
    }

    function stat(text) {
      lastStat = text || '';
      var el = document.getElementById('remoteStat');
      if (el) el.textContent = text;
    }

    // ── Bild, Zoom und Gesten gehoeren dem Mockup (Fernzugriff v2) ─────────
    // Das Bild IST das Trackpad: Lage/Groesse/Zoom rechnet rxLayout() im
    // Mockup, die Gesten auf der Flaeche ebenso. Hier bleiben nur Video,
    // Ton, Verbindung und das Zeiger-Modell (Vorhersage + Abgleich mit dem Mac).
    function applyView() { renderCursor(); }

    // ── Lokaler Zeiger ──────────────────────────────────────────────────────
    // Der Zeiger im Video lief jeder Bewegung um einen vollen Netz-Umlauf
    // hinterher (ueber das Tailscale-Relais 100-500 ms). Jetzt laesst der Mac
    // ihn aus dem Video weg (localCursor), und die App zeichnet ihn selbst:
    // Trackpad-Bewegungen verschieben ihn SOFORT um genau das Stueck, das sie
    // auch auf dem Mac bewegen (dx/dy sind Mac-Punkte, siehe input.darwin.ts).
    // Die echte Position kommt als remote:cursor und korrigiert nur, solange
    // gerade niemand bewegt — sonst risse die verspaetete Meldung den Zeiger
    // mitten in der Bewegung zurueck.
    // srv = letzte echte Position vom Mac. Der Mac meldet nur, wenn sich der
    // Zeiger BEWEGT — waehrend eigener Bewegung verworfene Meldungen kamen also
    // nie wieder, und eine einmal entstandene Abweichung (Eingaben, die beim
    // Neuverbinden unterwegs verloren gingen; die echte Maus am Mac) blieb fuer
    // immer: Zeiger sichtbar an einer Stelle, Klick landet an einer anderen.
    // Darum wird die zuletzt gemeldete Position nach jeder Bewegung, sobald
    // Ruhe ist, nachgezogen (settleCursor).
    var cursor = { x: 0.5, y: 0.5, known: false, lastLocalAt: 0, srv: null, settleTimer: null };
    var linkRttMs = 0;
    // display:block ist Pflicht: ein Inline-SVG sitzt auf der Grundlinie einer
    // Textzeile und rutschte so ~7 px UNTER den eigentlichen Punkt (gemessen) —
    // der Pfeil zeigte tiefer, als der Mac klickte.
    var CURSOR_SVG = '<svg viewBox="0 0 12 18" width="100%" height="100%" style="display:block" aria-hidden="true">'
      + '<path d="M0.5 0.5 L0.5 14.5 L4 11.2 L6.4 16.8 L8.6 15.9 L6.3 10.5 L11 10.5 Z" '
      + 'fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/></svg>';

    /** Zeichnen macht das Mockup (#rxCursor, folgt Zoom und Ausschnitt). */
    function renderCursor() {
      if (typeof window.rxCursorChanged === 'function') window.rxCursorChanged();
    }
    /** Fuer das Mockup: wo der Mac-Zeiger gerade steht (0..1), null = unbekannt/im Video. */
    function cursorPos() {
      var st = window.remoteState;
      return st.localCursor && st.running && cursor.known && st.w ? { x: cursor.x, y: cursor.y } : null;
    }

    /** Vorhersage: was die App gerade schickt, sieht sie sofort. */
    function predictCursor(ev) {
      var st = window.remoteState;
      if (!st.localCursor || !st.w) return;
      if (ev.t === 'd') {
        var ptsW = Math.max(1, Math.round(st.w / (st.scale || 1)) - 1);
        var ptsH = Math.max(1, Math.round(st.h / (st.scale || 1)) - 1);
        cursor.x = Math.min(1, Math.max(0, cursor.x + ev.dx / ptsW));
        cursor.y = Math.min(1, Math.max(0, cursor.y + ev.dy / ptsH));
      } else if (ev.t === 'm') {
        cursor.x = ev.x; cursor.y = ev.y;
      } else return;
      cursor.known = true;
      cursor.lastLocalAt = Date.now();
      renderCursor();
      armSettle();
    }

    function quietMs() { return Math.max(85, Math.min(220, (linkRttMs || 25) * 1.5 + 40)); }

    /** Nach der letzten eigenen Bewegung (plus Hin- und Rueckweg) die echte Position uebernehmen. */
    function armSettle() {
      if (cursor.settleTimer) clearTimeout(cursor.settleTimer);
      cursor.settleTimer = setTimeout(settleCursor, quietMs() + 15);
    }

    function settleCursor() {
      cursor.settleTimer = null;
      var wait = quietMs() - (Date.now() - cursor.lastLocalAt);
      if (wait > 0) { cursor.settleTimer = setTimeout(settleCursor, wait + 15); return; }
      if (!cursor.srv) return;
      cursor.x = cursor.srv.x; cursor.y = cursor.srv.y; cursor.known = true;
      renderCursor();
    }

    /** Echte Position vom Mac — gilt sofort, solange die eigene Bewegung ruht, sonst beim Nachziehen. */
    function serverCursor(p) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return;
      cursor.srv = { x: p.x, y: p.y };
      var quiet = Date.now() - cursor.lastLocalAt > quietMs();
      if (cursor.known && !quiet) {
        // Sanfte Drift-Korrektur waehrend der Bewegung, falls Vorhersage und
        // echte Mac-Position z.B. am Bildschirmrand minimal auseinanderlaufen.
        var errX = p.x - cursor.x, errY = p.y - cursor.y;
        if (Math.hypot(errX, errY) < 0.035) {
          cursor.x += errX * 0.25;
          cursor.y += errY * 0.25;
          renderCursor();
        }
        if (!cursor.settleTimer) armSettle();
        return;
      }
      cursor.x = p.x; cursor.y = p.y; cursor.known = true;
      renderCursor();
    }

    /** Lage und Groesse des Bildes rechnet das Mockup (rxLayout): Fuellen/Ganz,
     *  Ausschnitt folgt dem Zeiger, bei offener Tastatur wird es nie kleiner. */
    function layoutStage() {
      if (typeof window.rxLayout === 'function') window.rxLayout();
    }

    // ── Lebenszyklus der Buehne ─────────────────────────────────────────────
    // SCREEN_HOOKS.remote ruft buildRemoteScreen() bei JEDEM Wechsel auf den
    // Fernzugriffs-Bildschirm auf — nicht nur beim ersten Mal — und wirft dabei
    // Canvas, Overlay und Leiste komplett weg und baut sie neu (die Leiste
    // faellt dabei auch auf "Trackpad" zurueck). Das ist im Mockup so angelegt
    // und bleibt unangetastet. WebSocket und Dekoder wissen davon nichts und
    // laufen einfach weiter — nur unsere `canvas`/`ctx`-Referenzen wuerden sonst
    // auf ein verwaistes, unsichtbares Element zeigen: das Bild faellt beim
    // naechsten Bildschirmwechsel scheinbar aus, obwohl weiter Daten ankommen
    // und man es im Code nirgends sieht. Deshalb klinken wir uns hier ein:
    // nach jedem Neuaufbau (egal ob durch Navigation der App oder durch unser
    // eigenes start()) holen wir Canvas/Context frisch und spielen den letzten
    // Verbindungsstatus zurueck. Der Dekoder selbst wird dabei nicht angefasst
    // — er wird einfach weiterbedient, sein Zustand (SPS/PPS, letztes
    // Vollbild) bleibt gueltig, nur das Ziel seiner naechsten drawImage()-
    // Aufrufe aendert sich.
    // ── Entsperren per Fingerabdruck gibt es nur am Mac ─────────────────────
    // Der Sperrhinweis blieb vom Mac stehen: der Mac meldete "gesperrt", nach
    // dem Wechsel zu WIN setzte nichts das zurück (Windows meldet keinen
    // Sperrzustand). Und der Touch-ID-Knopf stand bei jedem Gerät da. Jetzt:
    // Zustand pro Verbindung, und der Server sagt im remote:started, ob das
    // Gerät entsperrt werden kann (aeltere Server: am Geraetenamen erkannt).
    var unlockKnown = null;
    (function () {
      var st = document.createElement('style');
      st.textContent = 'body.remote-no-unlock [data-btn="touchid"],'
        + 'body.remote-no-unlock [data-code="__touchid"],'
        + 'body.remote-no-unlock #remoteTouchId,'
        + 'body.remote-no-unlock #remoteLockBanner{display:none!important}';
      document.head.appendChild(st);
    })();
    function remoteUnlockable() {
      if (unlockKnown !== null) return unlockKnown;
      var id = window.__remoteSrv;
      var srv = (window.TMS_DATA.servers || []).filter(function (x) { return x.id === id; })[0];
      return !(srv && typeof window.__devShort === 'function' && window.__devShort(srv) === 'WIN');
    }
    function renderLockUi() {
      var can = remoteUnlockable();
      document.body.classList.toggle('remote-no-unlock', !can);
      var banner = document.getElementById('remoteLockBanner');
      if (banner) banner.hidden = !(can && window.remoteState.locked);
    }
    function resetLock() {
      window.remoteState.locked = false;
      unlockKnown = null;
      renderLockUi();
    }

    var realBuildRemoteScreen = window.buildRemoteScreen;
    window.buildRemoteScreen = function () {
      if (typeof realBuildRemoteScreen === 'function') realBuildRemoteScreen();
      // Zurueck im Fernzugriff: eine beim Verlassen pausierte Sitzung geht weiter.
      if (wantRunning && suspended) setTimeout(function () { window.TMSRemote.resume(); }, 0);
      canvas = document.getElementById('remoteCanvas');
      ctx = canvas ? canvas.getContext('2d') : null;
      layoutStage();
      renderLockUi();
      renderRemoteOpts();
      if (lastVeil) veil(lastVeil);
      if (lastStat) stat(lastStat);
    };

    function ensureDecoder() {
      if (decoder && decoder.state !== 'closed') return true;
      if (typeof VideoDecoder === 'undefined') {
        // Haeufigster Grund: die Seite laeuft nicht im sicheren Kontext (dann gibt
        // es WebCodecs gar nicht) — das sagen, statt das Geraet zu beschuldigen.
        veil(window.isSecureContext
          ? 'Dieses Geraet kann den Bildstrom nicht anzeigen (kein WebCodecs).'
          : 'Bildstrom gesperrt: die App-Oberflaeche laeuft nicht im sicheren Modus — bitte App aktualisieren.');
        return false;
      }
      decoder = new VideoDecoder({
        output: function (frame) {
          if (ctx) ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          frame.close();
        },
        error: function () {
          // Ein Dekoderfehler heilt nur mit einem frischen Vollbild.
          try { decoder.close(); } catch (e) {}
          decoder = null;
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'remote:keyframe' }));
        },
      });
      // Ohne `description` erwartet WebCodecs Annex-B — genau das, was der Server sendet.
      decoder.configure({ codec: 'avc1.42E01E', optimizeForLatency: true });
      return true;
    }

    function onBinary(buf) {
      var view = new Uint8Array(buf);
      if (view.length >= 6 && view[0] === 0x02) { onSoundPacket(view); return; }
      if (view.length >= 9 && view[0] === 0x03) { onPcmPacket(view); return; }
      if (view.length < 6 || (view[0] & 0x7f) !== 0x01) return;
      var keyframe = (view[0] & 0x80) !== 0;
      var ts = (view[1] << 24 | view[2] << 16 | view[3] << 8 | view[4]) >>> 0;
      // Quittung sofort beim Empfang: daraus misst der Server, wie viel sich
      // auf der Leitung staut, und verwirft lieber Bilder, als sekundenlang
      // hinterherzulaufen (server/src/remote/flow.ts).
      if (ws && ws.readyState === 1) ws.send('{"type":"remote:ack","payload":{"ts":' + ts + '}}');
      // Bild nicht zu sehen (suspend): Nachzügler von unterwegs verwerfen —
      // sie würden nur einen neuen Dekoder für nichts aufbauen.
      if (suspended) return;
      if (!ensureDecoder()) return;
      // Vor dem ersten Vollbild ist jedes Zwischenbild sinnlos — der Dekoder
      // haette keinen Ausgangspunkt und zeichnete graue Kloetze.
      if (decoder.state !== 'configured') return;
      // Kommt der Dekoder nicht hinterher, lieber aufs naechste Vollbild
      // springen als mit wachsendem Rueckstand weiterzuzeichnen. Ein
      // verworfenes Zwischenbild entwertet alle folgenden — also bis zum
      // Vollbild nichts mehr dekodieren und eines anfordern.
      // Windows (ffmpeg) kann kein Vollbild auf Anfrage schneiden — dort
      // hiesse Verwerfen bis zu 2 s Standbild. Ein paar Bilder Rueckstand,
      // wie sie ein Relais in Buendeln abliefert, holt der Dekoder in
      // Sekundenbruchteilen auf; erst ein echter Rueckstau wird verworfen.
      var lagLimit = window.remoteState.keyframeOnDemand === false ? 8 : 2;
      if (!keyframe && decoder.decodeQueueSize > lagLimit) decoder.__gotKey = false;
      if (!keyframe && !decoder.__gotKey) {
        // Hoechstens alle 500 ms nachfragen — geht eine Anforderung verloren
        // oder kommt das Vollbild spaet, fragt das naechste Zwischenbild erneut.
        var now = Date.now();
        if (ws && ws.readyState === 1 && now - (decoder.__keyAskedAt || 0) > 500) {
          decoder.__keyAskedAt = now;
          ws.send(JSON.stringify({ type: 'remote:keyframe' }));
        }
        return;
      }
      if (keyframe) decoder.__gotKey = true;
      decoder.decode(new EncodedVideoChunk({
        type: keyframe ? 'key' : 'delta',
        timestamp: ts * 1000,
        data: view.subarray(5),
      }));
    }

    function onControl(msg) {
      switch (msg.type) {
        case 'remote:started':
          // Neue Masse heissen neuer Bildaufbau — der alte Dekoder rechnet noch
          // mit der alten Groesse und wuerde verzerrte Bilder liefern. Trifft
          // sowohl den Helfer-Neustart nach einem Absturz als auch einen
          // echten Aufloesungswechsel (Monitor an-/abgesteckt, Umstellung) —
          // beide schicken ein frisches remote:started mit neuen Massen.
          if (decoder && (window.remoteState.w !== msg.payload.width
                       || window.remoteState.h !== msg.payload.height)) {
            try { decoder.close(); } catch (e) {}
            decoder = null;
          }
          window.remoteState.running = true;
          setRemoteAlive(curDev(), true);
          window.remoteState.localCursor = !!msg.payload.localCursor;
          window.remoteState.keyframeOnDemand = msg.payload.keyframeOnDemand !== false;
          if (typeof msg.payload.unlock === 'boolean') unlockKnown = msg.payload.unlock;
          renderLockUi();
          reportRemoteOpts(msg.payload);
          window.remoteState.w = msg.payload.width;
          window.remoteState.h = msg.payload.height;
          window.remoteState.scale = msg.payload.scale;
          retry = 0;
          // Sperrbildschirm/Hintergrund/Netzabbruch reissen die Verbindung
          // ohne dass jemand die Tastatur verlaesst — der Weg zum Mac war beim
          // Verbindungsabbruch (onclose) schon tot, darum konnte eine dort
          // noch festgestellte Sondertaste damals nicht geloest werden. Hier,
          // sobald running wieder true ist (also TMSRemote.input() wirklich
          // sendet), holt das dieselbe Funktion nach. remoteSticky blieb seit
          // dem Abbruch unveraendert (bewusst nicht am onclose zurueckgesetzt
          // — dort waere jeder Sendeversuch ohnehin verpufft), darum weiss
          // releaseAllSticky() hier noch, was tatsaechlich offen war; der
          // eingebaute "off"-Check macht den Aufruf beim ganz normalen ersten
          // Verbinden (nichts war je gedrueckt) zum No-op.
          if (typeof window.releaseAllSticky === 'function') window.releaseAllSticky();
          // Dieselbe Ueberlegung gilt fuer die harte Tastatur/Maus im Vollbild:
          // riss die Verbindung genau waehrend ein Hardware-Anschlag/-Klick
          // unten war, kam dessen Loslassen nie an. releaseHardwareInput()
          // weiss noch, was zuletzt gehalten wurde, und holt es hier nach.
          if (typeof window.releaseHardwareInput === 'function') window.releaseHardwareInput();
          veil('');
          layoutStage();
          break;
        case 'remote:status':
          // I16: Spezifikation Abschnitt 7 verlangt "fps · ms" (Verzoegerung)
          // in der Kopfzeile, nicht die Bitrate — und der Server misst
          // rttMs jetzt wirklich (Ping/Pong auf der Steuerverbindung),
          // statt ihn fest auf 0 zu senden.
          // Verworfene Bilder sichtbar machen: daran sieht man am Geraet, ob
          // ein Standbild von der Leitung kam.
          stat(msg.payload.fps + ' fps · ' + msg.payload.rttMs + ' ms'
            + (msg.payload.dropped > 0 ? ' · ' + msg.payload.dropped + ' verworfen' : ''));
          linkRttMs = msg.payload.rttMs || 0;
          break;
        case 'remote:cursor':
          serverCursor(msg.payload);
          break;
        case 'remote:locked':
          window.remoteState.locked = !!(msg.payload && msg.payload.locked);
          renderLockUi();
          break;
        case 'remote:stopped':
          window.remoteState.running = false;
          setRemoteAlive(curDev(), false);
          renderCursor();
          veil('Beendet');
          break;
        case 'remote:error':
          window.remoteState.running = false;
          setRemoteAlive(curDev(), false);
          veil(remoteErrorText(msg.payload));
          break;
      }
    }

    function connect() {
      if (!remoteTarget) { veil('Kein Server verbunden.'); return; }
      canvas = document.getElementById('remoteCanvas');
      ctx = canvas ? canvas.getContext('2d') : null;

      var url = 'ws://' + remoteTarget.host + ':' + remoteTarget.port
              + '/remote?token=' + encodeURIComponent(remoteTarget.token);
      // Jede Verbindung reagiert nur, solange sie DIE aktuelle ist. Das
      // Schließen einer alten meldet sich erst eine Netz-Runde später — beim
      // Gerätewechsel stand dann schon die neue, und der späte onclose der
      // alten setzte `ws = null`: die neue lief unbemerkt weiter, ein
      // "Neuversuch" öffnete eine dritte, und zwei Bildströme (MAC und WIN)
      // zeichneten abwechselnd in denselben Dekoder.
      var sock = new WebSocket(url);
      ws = sock;
      sock.binaryType = 'arraybuffer';

      sock.onopen = function () {
        if (ws !== sock) { try { sock.close(); } catch (e) {} return; }
        // Neue Verbindung, Zeigerposition unbekannt. NICHT erst bei
        // remote:started zuruecksetzen: die erste Positionsmeldung des Macs
        // kommt VOR remote:started an und waere sonst gleich wieder vergessen.
        cursor.known = false;
        cursor.srv = null;
        if (cursor.settleTimer) { clearTimeout(cursor.settleTimer); cursor.settleTimer = null; }
        // Der Mac meldet seinen Sperrzustand gleich zu Beginn neu.
        resetLock();
        ws.send(JSON.stringify({ type: 'remote:start', payload: startPayload() }));
        // Gerade nicht zu sehen (anderer Bildschirm, Hintergrund): die Sitzung
        // laeuft, aber ohne Bildstrom.
        if (suspended) ws.send(JSON.stringify({ type: 'remote:view', payload: { visible: false } }));
        veil('Verbinde …');
      };
      sock.onmessage = function (e) {
        if (ws !== sock) return;
        if (typeof e.data === 'string') { try { onControl(JSON.parse(e.data)); } catch (err) {} }
        else onBinary(e.data);
      };
      sock.onclose = function () {
        if (ws !== sock) return; // eine längst abgelöste Verbindung
        ws = null;
        if (decoder) { try { decoder.close(); } catch (e) {} decoder = null; }
        window.remoteState.running = false;
        renderCursor();
        // N1: waehrend suspend() darf hier NIE ein Wiederverbindungs-Zeitgeber
        // entstehen — wantRunning bleibt bei suspend() absichtlich `true`
        // (siehe suspended-Deklaration oben), also reicht dessen Pruefung
        // allein nicht mehr.
        soundReset();
        // Auch im Hintergrund/auf anderem Bildschirm wieder verbinden: die
        // Sitzung soll laufen, bis der Nutzer sie schliesst (der Server haelt
        // sie inzwischen, siehe remote.socket.ts park()).
        if (!wantRunning) return;
        // Nie aufgeben: die Verbindung faellt unterwegs staendig kurz weg.
        retry = Math.min(retry + 1, 6);
        veil('Verbindung verloren — neuer Versuch …');
        retryTimer = setTimeout(connect, Math.min(500 * retry, 4000));
      };
      sock.onerror = function () { try { sock.close(); } catch (e) {} };
    }

    // C2: eine Sitzung wird gewuenscht (wantRunning), aber es steht noch
    // keine Verbindung — nachziehen, sobald das moeglich ist. Das `!ws`
    // deckt beides ab: kein doppelter Verbindungsaufbau, wenn die
    // Zugangsdaten erneut gesetzt werden (z.B. Server-Wechsel), waehrend
    // schon eine Verbindung steht oder gerade aufgebaut wird.
    //
    // Nachpruefung zu C2: ein noch anhaengender Wiederverbindungs-Zeitgeber
    // (aus einem echten Netzabbruch, nicht aus suspend()) wird hier VOR dem
    // eigenen connect() geraeumt — sonst feuert er kurz danach ein zweites
    // Mal, waehrend die frische Verbindung schon steht.
    /** Bildverbindung zu, Sitzung bleibt: kein remote:stop — der Server laesst
     *  sie ruhen (Geraetewechsel). Alles Gehaltene vorher loslassen. */
    function detach() {
      if (typeof window.releaseAllSticky === 'function') window.releaseAllSticky();
      if (typeof window.setRemoteFullscreen === 'function') window.setRemoteFullscreen(false);
      if (typeof window.releaseRemotePadHold === 'function') window.releaseRemotePadHold();
      wantRunning = false;
      reportSound();
      suspended = false;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      var old = ws;
      ws = null;
      if (old) { try { old.close(); } catch (e) {} }
      if (decoder) { try { decoder.close(); } catch (e) {} decoder = null; }
      window.remoteState.running = false;
      resetLock();
      soundReset();
    }

    function maybeConnect() {
      if (!wantRunning || ws) return;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      connect();
    }
    // Von setRemoteTarget (oben in dieser Datei) aufgerufen, sobald React
    // Native die Zugangsdaten liefert — das ist der eigentliche Fix fuer C2.
    window.__tmsRemoteTargetReady = maybeConnect;

    window.__tmsBiometricSudo = function (cardId) {
      var sid = byCard[cardId] || (window.__tmsState && window.__tmsState.activeCardId && byCard[window.__tmsState.activeCardId]);
      post('biometric:unlock', { mode: 'sudo', sessionId: sid || undefined });
    };

    window.TMSRemote = {
      /** Fernzugriff auf ein bestimmtes Gerät (Insel: MAC | WIN). Erst sauber
       *  trennen und die alten Zugangsdaten vergessen — sonst verbände start()
       *  sofort wieder mit dem vorigen Gerät, und die neuen Daten kämen zu spät. */
      switchTo: function (id) {
        var cur = curDev();
        // Dasselbe Geraet, Sitzung laeuft schon: nur wieder zeigen.
        if (id && id === cur && wantRunning) {
          suspended = true;
          window.TMSRemote.resume();
          return;
        }
        if (cur) presetByDev[cur] = preset;
        // Das vorige Geraet NICHT beenden: ohne remote:stop ruht seine Sitzung
        // auf dem Rechner weiter, bis der Nutzer sie schliesst.
        detach();
        remoteTarget = null;
        // Das letzte Bild gehört dem vorigen Gerät — nicht stehen lassen, bis
        // das neue sein erstes Vollbild schickt.
        if (ctx && canvas) { try { ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (e) {} }
        window.__tmsOpenRemote(id);
        window.TMSRemote.start(presetByDev[id] || 'auto');
      },
      /** Sitzung eines Geraets beenden (⋮-Menü „Beenden“), ohne den
       *  Fernzugriff zu öffnen. Laeuft sie ueber die eigene (pausierte)
       *  Verbindung: Stopp dort hinein und nicht neu verbinden. Bestaetigt wird
       *  in jedem Fall ueber eine frische Verbindung — die alte kann halb tot
       *  sein, und der Server beendet die Sitzung, wo immer sie gerade haengt.
       *  Der gruene Ring geht erst mit dieser Bestaetigung weg. */
      closeDevice: function (id) {
        if (!id) return;
        if (id === curDev() && (wantRunning || ws)) window.TMSRemote.stop({ keepMark: true });
        window.__closeRemoteDevice(id);
      },
      start: function (which) {
        preset = which || preset;
        wantRunning = true;
        reportSound();
        suspended = false; // ein expliziter Start raeumt einen etwaigen Rest auf
        if (typeof window.buildRemoteScreen === 'function' && !document.getElementById('remoteStage')) {
          window.buildRemoteScreen();
        }
        maybeConnect();
      },
      stop: function (opts) {
        // Muss VOR dem Schliessen laufen: releaseAllSticky() sendet ueber
        // TMSRemote.input(), das nur sendet, solange ws noch offen und
        // remoteState.running noch true ist. Nach dem close()/running=false
        // weiter unten kommt ein Loslassen nicht mehr durch — eine
        // festgestellte Sondertaste bliebe auf dem Mac haengen.
        if (typeof window.releaseAllSticky === 'function') window.releaseAllSticky();
        // C3/I6: Vollbild gehoert zu einer Sitzung, keine Sitzung heisst kein
        // Vollbild — sonst bleiben die Dokument-Zuhoerer (Tastatur/Zeiger/Rad,
        // siehe weiter unten) aktiv, waehrend laengst getrennt ist, und fangen
        // die eigene Tastatur der App ab. setRemoteFullscreen(false) loest
        // dabei auch alles, was eine angeschlossene Hardware-Tastatur/-Maus
        // noch haelt (releaseHardwareInput) — derselbe Grund wie bei
        // releaseAllSticky() oben, nur fuer den Hardware-Weg.
        if (typeof window.setRemoteFullscreen === 'function') window.setRemoteFullscreen(false);
        // I6: und ein noch laufendes Trackpad-Ziehen bzw. ein gehaltener
        // fester Links-/Rechtsklick-Knopf — der dritte Weg, auf dem eine
        // Maustaste haengen bleiben kann, den weder releaseAllSticky()
        // (Bildschirmtastatur) noch setRemoteFullscreen() (Hardware) abdeckt.
        if (typeof window.releaseRemotePadHold === 'function') window.releaseRemotePadHold();
        // Muss VOR ws.close() gesetzt sein (siehe onclose oben): sonst sieht
        // der noch anhaengende onclose-Handler kurz "wantRunning === true"
        // und plant faelschlich einen Wiederverbindungs-Zeitgeber.
        wantRunning = false;
        reportSound();
        suspended = false;
        // keepMark: closeDevice() nimmt den Ring erst mit der Bestaetigung weg.
        if (!(opts && opts.keepMark === true)) setRemoteAlive(curDev(), false);
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'remote:stop' }));
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
        if (decoder) { try { decoder.close(); } catch (e) {} decoder = null; }
        window.remoteState.running = false;
        resetLock();
        soundReset();
      },
      /**
       * I7: der Hintergrundwechsel (SeasonTwoWebRoot.tsx, ueber AppState)
       * ruft diese beiden statt start()/stop() direkt. Der Unterschied zu
       * stop(): wantRunning bleibt unangetastet — es ist der Merker dafuer,
       * ob der NUTZER eine Sitzung will, nicht ob sie gerade laeuft. Wuerde
       * suspend() wantRunning auf false setzen, koennte resume() beim
       * Zurueckkehren nicht mehr unterscheiden "war vorher an" von "wurde
       * per 'Trennen' beendet" — und wuerde jede Rueckkehr in den
       * Vordergrund eine neue Aufnahme samt Energie-Assertion auf dem PC
       * starten, obwohl der Nutzer laengst woanders ist.
       */
      suspend: function () {
        if (typeof window.releaseAllSticky === 'function') window.releaseAllSticky();
        if (typeof window.setRemoteFullscreen === 'function') window.setRemoteFullscreen(false);
        if (typeof window.releaseRemotePadHold === 'function') window.releaseRemotePadHold();
        // N1 (Nachpruefung): MUSS vor ws.close() gesetzt sein — wantRunning
        // bleibt hier absichtlich `true` (siehe Kommentar oben), also ist
        // `suspended` der einzige Weg, den noch anhaengenden onclose-Handler
        // davon abzuhalten, selbst einen Wiederverbindungs-Zeitgeber zu
        // planen. Ohne das baute sich die Sitzung im Hintergrund von selbst
        // wieder auf (neue Aufnahme + Energie-Assertion auf dem Mac), und
        // ein spaeteres resume() haette zusammen mit diesem Zeitgeber zwei
        // parallele Verbindungen aufgemacht.
        //
        // Neu: weg vom Fernzugriff / App im Hintergrund heisst nur noch "Bild
        // aus". Die Verbindung und die Sitzung auf dem Rechner bleiben (der
        // Nutzer will sie behalten, bis er sie selbst schliesst); der Server
        // schickt solange keine Bilder, der Ton laeuft weiter.
        suspended = true;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'remote:view', payload: { visible: false } }));
        // Den Hardware-Dekoder freigeben, solange niemand hinsieht. Beim
        // Zurückkommen schickt der Rechner ein Vollbild — damit entsteht er neu.
        if (decoder) { try { decoder.close(); } catch (e) {} decoder = null; }
      },
      /** Setzt nur fort, was vorher lief (wantRunning) — nach einem
       *  expliziten "Trennen" bleibt das ein No-op, siehe suspend() oben. */
      resume: function () {
        // Nur im Fernzugriff selbst: kommt die App aus dem Hintergrund zurueck,
        // waehrend das Terminal offen ist, bleibt die Sitzung pausiert.
        if (!remoteVisible()) return;
        suspended = false;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'remote:view', payload: { visible: true } }));
        else maybeConnect();
      },
      /** Stufenwechsel = neu starten: ffmpeg auf Windows kann die Bitrate nicht im Lauf aendern. */
      /** Ton aufs Handy / Verdunkeln umschalten — neu starten wie bei der Qualitaet. */
      toggleOption: function (name) {
        if (name !== 'audio' && name !== 'curtain') return;
        remoteOpts[name] = !remoteOpts[name];
        saveRemoteOpts();
        reportSound();
        renderRemoteOpts();
        if (name === 'audio') { if (remoteOpts.audio) soundCtx(); else soundReset(); }
        if (typeof window.toast === 'function') {
          window.toast(name === 'audio'
            ? (remoteOpts.audio ? 'Ton kommt aufs Handy (am Computer stumm)' : 'Ton bleibt am Computer')
            : (remoteOpts.curtain ? 'Bildschirm am Computer wird verdunkelt' : 'Bildschirm am Computer bleibt an'));
        }
        if (wantRunning && ws && ws.readyState === 1) {
          soundReset();
          ws.send(JSON.stringify({ type: 'remote:stop' }));
          ws.send(JSON.stringify({ type: 'remote:start', payload: startPayload() }));
        }
      },
      setQuality: function (which) {
        preset = which;
        if (curDev()) presetByDev[curDev()] = which;
        if (!wantRunning) return;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'remote:stop' }));
          ws.send(JSON.stringify({ type: 'remote:start', payload: startPayload() }));
        }
      },
      input: function (ev) {
        if (ws && ws.readyState === 1 && window.remoteState.running) {
          ws.send(JSON.stringify(ev));
          predictCursor(ev);
        }
      },
      dictate: function () { post('mic:start', { target: 'remote' }); },
      // Entsperren gilt dem Gerät, das gerade im Fernzugriff zu sehen ist.
      biometricUnlock: function () { post('biometric:unlock', { mode: 'remote', serverId: window.__remoteSrv || undefined }); },
      cursorPos: cursorPos,
    };

    // Der Mockup ruft das beim Vollbildwechsel und nach Gesten auf, kommt aber
    // nicht in diese Kapsel hinein — deshalb ausdruecklich nach aussen geben.
    window.layoutRemoteStage = layoutStage;
    window.addEventListener('resize', layoutStage);

    // ── Vollbild: angeschlossene Tastatur und Maus ──────────────────────────
    // Manuell umgeschaltet (siehe window.setRemoteFullscreen im Mockup) — hier
    // wird nur noch weitergeleitet, solange window.remoteState.fullscreen an ist.

    /** Rechteck des Bildes innerhalb der Buehne, in Bildschirmkoordinaten (inkl. Zoom/Schwenk). */
    function stageBox() {
      var target = canvas || document.getElementById('remoteCanvas') || document.getElementById('remoteStage');
      if (!target || !window.remoteState.w) return null;
      var r = target.getBoundingClientRect();
      var box = window.fitRect(window.remoteState.w, window.remoteState.h, r.width, r.height);
      return { x: r.left + box.x, y: r.top + box.y, w: box.w, h: box.h };
    }

    // Gehaltene Hardware-Tasten/-Maustasten: wer hier steht, hat noch KEIN
    // Loslassen bekommen. Das ist der Fehlertyp, der in diesem Vorhaben schon
    // mehrfach auftrat (Trackpad-Rechtsklick, Bildschirm-Sondertasten) — bei
    // echter Hardware kommen keydown/keyup und Maustasten-Events von ausserhalb
    // unserer Kontrolle, darum wird hier gegengebucht statt blind weitergereicht.
    var heldKeys = {};      // KeyboardEvent.code -> true
    var heldButtons = {};   // 'l' | 'm' | 'r' -> true

    /**
     * Loest aktiv alles, was die angeschlossene Tastatur/Maus noch haelt.
     * Muss an DREI Stellen laufen, nicht nur einer:
     *  - Vollbild verlassen (window.setRemoteFullscreen(false) im Mockup)
     *  - Fensterfokus weg (blur) — z.B. Sperrbildschirm, App-Wechsel, waehrend
     *    eine Taste/Maustaste unten war; ohne das bleibt sie auf dem Mac haengen
     *  - frischer Verbindungsaufbau (remote:started) — falls die Verbindung
     *    genau waehrend eines Tastendrucks abriss, kam das Loslassen nie an
     *    (derselbe Grund, aus dem releaseAllSticky() dort schon aufgerufen wird)
     */
    function releaseHardwareInput() {
      Object.keys(heldKeys).forEach(function (code) {
        window.TMSRemote.input({ t: 'k', c: code, d: false, mods: { s: false, c: false, a: false, m: false } });
      });
      heldKeys = {};
      Object.keys(heldButtons).forEach(function (b) {
        window.TMSRemote.input({ t: 'b', b: b, d: false });
      });
      heldButtons = {};
    }
    window.releaseHardwareInput = releaseHardwareInput;
    window.addEventListener('blur', releaseHardwareInput);

    // Angeschlossene Maus + direkter Touch/Stift im Samsung-DeX-Monitormodus:
    // Auf dem iPad muss sowohl das Magic-Keyboard-Trackpad (mouse) als auch der
    // Finger (touch) und der Apple Pencil (pen) direkt in Samsung DeX klicken
    // und ziehen koennen.
    var heldTouchId = null;

    function isDeXOverlayElement(target) {
      return !!(target && target.closest && (
        target.closest('#remoteExit') ||
        target.closest('#dexFab') ||
        target.closest('#dexHudBar') ||
        target.closest('#dexTerminalDock')
      ));
    }

    document.addEventListener('pointermove', function (e) {
      if (!window.remoteState.fullscreen) return;
      if (isDeXOverlayElement(e.target)) return;
      if (e.pointerType !== 'mouse') return;
      var box = stageBox();
      if (!box) return;
      var p = window.toStageNormalized(e.clientX, e.clientY, box);
      if (p) window.TMSRemote.input({ t: 'm', x: p.x, y: p.y });
    });

    document.addEventListener('pointerdown', function (e) {
      if (!window.remoteState.fullscreen) return;
      if (isDeXOverlayElement(e.target)) return;
      if (window.remoteState.dexMode) focusDeXKeys();
      // Finger and pencil belong to the stage's gesture handler (direct mode in DeX); handling
      // them here as well sent every tap twice with conflicting positions.
      if (e.pointerType !== 'mouse') return;
      var box = stageBox();
      if (!box || e.clientX < box.x || e.clientX > box.x + box.w || e.clientY < box.y || e.clientY > box.y + box.h) return;
      e.preventDefault();
      // iPadOS WKWebView reports no hover moves for the Magic Keyboard trackpad, so the remote
      // pointer would stay where it was: move it to the click position first.
      var p = window.toStageNormalized(e.clientX, e.clientY, box);
      if (p) window.TMSRemote.input({ t: 'm', x: p.x, y: p.y });
      var b = e.button === 2 ? 'r' : e.button === 1 ? 'm' : 'l';
      heldButtons[b] = true;
      window.TMSRemote.input({ t: 'b', b: b, d: true });
    });
    function onFullscreenPointerRelease(e) {
      if (!window.remoteState.fullscreen) return;
      if (heldTouchId !== null && e.pointerId === heldTouchId) {
        heldTouchId = null;
        if (heldButtons['l']) {
          delete heldButtons['l'];
          window.TMSRemote.input({ t: 'b', b: 'l', d: false });
        }
        return;
      }
      if (e.pointerType !== 'mouse') return;
      var b = e.button === 2 ? 'r' : e.button === 1 ? 'm' : 'l';
      if (!heldButtons[b]) return;
      delete heldButtons[b];
      window.TMSRemote.input({ t: 'b', b: b, d: false });
    }
    document.addEventListener('pointerup', onFullscreenPointerRelease);
    document.addEventListener('pointercancel', onFullscreenPointerRelease);
    document.addEventListener('contextmenu', function (e) {
      if (window.remoteState.fullscreen) e.preventDefault();
    });
    document.addEventListener('wheel', function (e) {
      if (!window.remoteState.fullscreen) return;
      if (isDeXOverlayElement(e.target)) return;
      e.preventDefault();
      window.TMSRemote.input({ t: 's', dx: Math.round(-e.deltaX / 20), dy: Math.round(-e.deltaY / 20) });
    }, { passive: false });

    // Angeschlossene Tastatur: Tasten abfangen, bevor der Browser sie deutet.
    function forwardKey(e, down) {
      if (!window.remoteState.fullscreen) return;
      if (isDeXOverlayElement(e.target)) return;
      if (e.key === 'Escape' && e.shiftKey) {      // Notausstieg, falls das Abzeichen verdeckt ist
        if (down) window.setRemoteFullscreen(false);
        return;
      }
      e.preventDefault();
      if (down) heldKeys[e.code] = true; else delete heldKeys[e.code];
      window.TMSRemote.input({
        t: 'k', c: e.code, d: down,
        mods: { s: e.shiftKey, c: e.ctrlKey, a: e.altKey, m: e.metaKey },
      });
    }
    // WKWebView only hands hardware-keyboard events to the page while an element has focus.
    // In DeX mode a hidden field without on-screen keyboard keeps that focus (keys are
    // intercepted in forwardKey, nothing is ever typed into it).
    function dexKeySink() {
      var el = document.getElementById('dexKeySink');
      if (!el) {
        el = document.createElement('textarea');
        el.id = 'dexKeySink';
        el.setAttribute('inputmode', 'none');
        el.setAttribute('autocapitalize', 'off');
        el.setAttribute('autocorrect', 'off');
        el.setAttribute('spellcheck', 'false');
        el.setAttribute('aria-hidden', 'true');
        el.style.cssText = 'position:fixed;left:-40px;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none;';
        el.addEventListener('input', function () { el.value = ''; });
        document.body.appendChild(el);
      }
      return el;
    }
    function focusDeXKeys() {
      if (!window.remoteState || !window.remoteState.dexMode) return;
      var el = dexKeySink();
      if (document.activeElement !== el) { try { el.focus({ preventScroll: true }); } catch (err) {} }
    }
    window.focusDeXKeys = focusDeXKeys;

    // Native iPad input in DeX mode (TMSUsbRelay → useDeXUsbMonitor → here): keyboard, trackpad
    // hover and trackpad scrolling, which WKWebView never reports to the page.
    window.TMSBridge.dexInput = function (ev) {
      if (!ev || !window.remoteState || !window.remoteState.dexMode || !window.TMSRemote) return;
      if (ev.t === 'hover') {
        var box = stageBox();
        if (!box) return;
        var p = window.toStageNormalized(ev.x, ev.y, box);
        if (p) window.TMSRemote.input({ t: 'm', x: p.x, y: p.y });
        return;
      }
      window.TMSRemote.input(ev);
    };
    window.blurDeXKeys = function () { var el = document.getElementById('dexKeySink'); if (el) el.blur(); };
    document.addEventListener('keydown', function (e) { forwardKey(e, true); }, true);
    document.addEventListener('keyup', function (e) { forwardKey(e, false); }, true);
  })();

  /** Fehlercodes des Servers in Saetze, die weiterhelfen. */
  function remoteErrorText(p) {
    switch (p && p.code) {
      case 'permission_screen':
        return 'Der Mac darf seinen Bildschirm nicht teilen.\n'
             + 'Systemeinstellungen → Datenschutz & Sicherheit → Bildschirmaufnahme';
      case 'permission_input':
        return 'Der Mac darf keine Eingaben annehmen.\n'
             + 'Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen';
      case 'display_asleep':
        return 'Der Bildschirm des Macs ist eingeschlafen oder es ist keiner angeschlossen. Gleich noch einmal versuchen.';
      case 'capture_unavailable':
        return 'Auf dem PC fehlt ffmpeg. Einmalig einrichten:  winget install ffmpeg';
      case 'disabled':
        return 'Der Fernzugriff ist auf diesem Server abgeschaltet.';
      case 'helper_crashed':
        return 'Die Bildschirmaufnahme ist abgestuerzt. Erneut versuchen.';
      default:
        return (p && p.message) || 'Der Fernzugriff ist fehlgeschlagen.';
    }
  }

  // ══ Woran gearbeitet wird + Antwort lesen ═══════════════════════════════
  // Der Server liest den Titel, den das KI-Werkzeug seinem Terminal gibt, und
  // meldet nur echte Wechsel (terminal:activity). Hier landet das auf der
  // Karte: session.task / session.taskState, gezeichnet von window.__taskHtml.
  var activityOf = {};     // sessionId -> { task, state } — auch für Karten, die es noch nicht gibt
  function applyActivity(sessionId) {
    var cardId = cardOf(sessionId);
    if (!cardId) return;
    var sess = (window.TMS_DATA.sessions || []).find(function (x) { return x.id === cardId; });
    if (!sess) return;
    var a = activityOf[sessionId] || null;
    var was = sess.taskState || null;
    var next = a ? a.state : null;
    var task = a ? (a.task || '') : '';
    if (was === next && (sess.task || '') === task) return;
    if (was === 'working' && next === 'done') {
      // Eine Antwort ist fertig. Liest der Nutzer gerade genau diese Sitzung,
      // rückt sie nach; war das Terminal nicht vorne, bekommt das Buch einen Punkt.
      var reading = window.TMSReader && window.TMSReader.isOpen && window.TMSReader.isOpen();
      var front = !window.__tmsAppInactive && typeof window.dockTargetId === 'function' && window.dockTargetId() === cardId;
      if (!front && !reading) sess.answerNew = true;
      if (reading) setTimeout(function () { window.TMSReader.refresh(cardId); }, 400); // der Verlauf wird kurz nach dem Titel geschrieben
    }
    if (next === 'working' || next === null) sess.answerNew = false;
    sess.task = task;
    sess.taskState = next;
    if (typeof window.__taskSync === 'function') window.__taskSync(cardId);
  }
  window.TMSBridge.setActivities = function (activities) {
    Object.keys(activities || {}).forEach(function (sessionId) {
      var a = activities[sessionId];
      if (a && typeof a.state === 'string') activityOf[sessionId] = { task: String(a.task || ''), state: a.state };
      else delete activityOf[sessionId];
      applyActivity(sessionId);
    });
  };

  // Lesemodus: die Seite fragt über diese Funktion (liquid-deck/reader.js).
  var readerWaiting = {};  // sessionId -> Rückruf
  window.__readerRequest = function (cardId, cb) {
    var sessionId = byCard[cardId];
    if (!sessionId) { cb({ answers: [], open: false, reason: 'no-claude' }); return; }
    readerWaiting[sessionId] = cb;
    post('reader:get', { sessionId: sessionId });
  };
  window.TMSBridge.readerAnswers = function (sessionId, payload) {
    var cb = readerWaiting[sessionId];
    if (!cb) return;
    delete readerWaiting[sessionId];
    cb(payload || { answers: [], open: false, reason: 'error' });
  };

  // Vorlesen: die Sprachausgabe des Handys (android: SpeechModule.kt). Die Seite
  // schickt die Stücke, zurück kommt, welches gerade gesprochen wird.
  var speechListener = null;
  window.__readerSpeech = {
    speak: function (parts, german, onEvent) { speechListener = onEvent; post('reader:speak', { parts: parts, german: !!german }); },
    stop: function () { speechListener = null; post('reader:speakStop', {}); },
  };
  window.TMSBridge.readerSpeech = function (ev) {
    var l = speechListener;
    if (!l) return;
    if (ev && (ev.done || ev.error)) speechListener = null;
    l(ev || {});
  };

  // ══ Samsung DeX USB-C Auto-Monitor & Split-Stage ══════════════════════════
  var prevScreenBeforeDeX = 'terminals';
  var dexSplitOpen = false;

  // DeX monitor chrome: the Fold's desktop always fills the whole iPad. The HUD (top) and the
  // remote shortcut dock (bottom) are hidden; a small floating button toggles them, and they
  // then lie OVER the picture (the picture never shrinks or moves). Nothing appears by itself.
  function ensureDeXChromeStyle() {
    if (document.getElementById('dexChromeStyle')) return;
    var st = document.createElement('style');
    st.id = 'dexChromeStyle';
    st.textContent = ''
      + 'body.dex-mode section.rx .rx-surface{top:0 !important;bottom:0 !important;background:#000;}'
      + 'body.dex-mode section.rx .rx-dock{position:absolute !important;left:0;right:0;bottom:0;z-index:20;transition:transform .2s ease,opacity .2s ease;}'
      + 'body.dex-mode:not(.dex-chrome) section.rx .rx-dock{transform:translateY(120%);opacity:0;pointer-events:none;}'
      + 'body.dex-mode #dexHudBar{transition:transform .2s ease,opacity .2s ease;}'
      + 'body.dex-mode:not(.dex-chrome) #dexHudBar{transform:translate(-50%,-150%) !important;opacity:0;pointer-events:none;}'
      + 'body.dex-mode #dock,body.dex-mode #statusHeader,body.dex-mode .rx-gexit,body.dex-mode .remote-badge{display:none !important;}'
      + '#dexFab{position:fixed;z-index:10001;width:38px;height:38px;border-radius:19px;display:none;'
      + 'align-items:center;justify-content:center;background:rgba(15,23,42,.55);border:1px solid rgba(255,255,255,.22);'
      + 'color:#fff;font:600 15px var(--font-ui,sans-serif);box-shadow:0 4px 14px rgba(0,0,0,.45);'
      + '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);touch-action:none;user-select:none;opacity:.7;}'
      + '#dexFab.on{opacity:1;background:rgba(2,132,199,.85);}'
      + 'body.dex-mode #dexFab{display:flex;}';
    document.head.appendChild(st);

    // Floating toggle, draggable so it never sits on something you need.
    var fab = document.createElement('div');
    fab.id = 'dexFab';
    fab.textContent = '☰';
    var pos = null;
    try { pos = JSON.parse(localStorage.getItem('tms-dex-fab') || 'null'); } catch (e) {}
    function place(x, y) {
      var w = window.innerWidth || 1024, h = window.innerHeight || 768;
      x = Math.max(4, Math.min(w - 42, x)); y = Math.max(4, Math.min(h - 42, y));
      fab.style.left = x + 'px'; fab.style.top = y + 'px';
      return { x: x, y: y };
    }
    place(pos ? pos.x : (window.innerWidth || 1024) - 54, pos ? pos.y : 14);
    var drag = null;
    fab.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: fab.offsetLeft, oy: fab.offsetTop, moved: false };
      try { fab.setPointerCapture(e.pointerId); } catch (err) {}
    });
    fab.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      e.stopPropagation();
      var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      place(drag.ox + dx, drag.oy + dy);
    });
    function release(e) {
      if (!drag || e.pointerId !== drag.id) return;
      e.stopPropagation();
      if (drag.moved) {
        try { localStorage.setItem('tms-dex-fab', JSON.stringify({ x: fab.offsetLeft, y: fab.offsetTop })); } catch (err) {}
      } else {
        toggleDeXChrome();
      }
      drag = null;
    }
    fab.addEventListener('pointerup', release);
    fab.addEventListener('pointercancel', function (e) { drag = null; });
    document.body.appendChild(fab);
  }
  function toggleDeXChrome(force) {
    var on = typeof force === 'boolean' ? force : !document.body.classList.contains('dex-chrome');
    document.body.classList.toggle('dex-chrome', on);
    var fab = document.getElementById('dexFab');
    if (fab) fab.classList.toggle('on', on);
  }
  window.toggleDeXChrome = toggleDeXChrome;

  function ensureDeXHudDom() {
    ensureDeXChromeStyle();
    var hud = document.getElementById('dexHudBar');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'dexHudBar';
      hud.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9999;'
        + 'display:none;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;'
        + 'background:rgba(15,23,42,0.86);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);'
        + 'border:1px solid rgba(56,189,248,0.45);color:#f8fafc;font:600 12px var(--font-ui, sans-serif);'
        + 'box-shadow:0 8px 24px rgba(0,0,0,0.45);';
      hud.innerHTML = '<span style="color:#38bdf8">⚡ DeX USB</span>'
        + '<span id="dexHudDevice" style="opacity:0.9">Fold 7</span>'
        + '<span id="dexHudStat" style="opacity:0.75;font-weight:500"></span>'
        + '<button id="dexSplitBtn" type="button" style="margin-left:4px;padding:4px 9px;border-radius:999px;'
        + 'border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);color:#fff;font:600 11.5px var(--font-ui, sans-serif);cursor:pointer">'
        + '⌨️ Terminal-Dock</button>'
        + '<button id="dexExitBtn" type="button" style="padding:4px 9px;border-radius:999px;'
        + 'border:1px solid rgba(248,113,113,0.4);background:rgba(248,113,113,0.16);color:#fecaca;font:600 11.5px var(--font-ui, sans-serif);cursor:pointer">'
        + 'Beenden</button>';
      document.body.appendChild(hud);

      var splitBtn = document.getElementById('dexSplitBtn');
      if (splitBtn) splitBtn.addEventListener('click', function () {
        toggleDeXSplitDock(!dexSplitOpen);
      });
      var exitBtn = document.getElementById('dexExitBtn');
      if (exitBtn) exitBtn.addEventListener('click', function () {
        window.TMSBridge.stopDeXMonitor();
        post('dex:manualStop', {});
      });
    }

    var dock = document.getElementById('dexTerminalDock');
    if (!dock) {
      dock = document.createElement('div');
      dock.id = 'dexTerminalDock';
      dock.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:250px;z-index:9998;'
        + 'display:none;flex-direction:column;background:rgba(9,13,22,0.96);'
        + 'border-top:1px solid rgba(56,189,248,0.38);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);'
        + 'padding:8px 12px;color:#e2e8f0;font:12.5px var(--font-mono, monospace);';
      dock.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font:600 12px var(--font-ui, sans-serif)">'
        + '<span style="color:#38bdf8">TMS Terminal · Split-Stage unter Samsung DeX</span>'
        + '<button id="dexDockCloseBtn" type="button" style="background:none;border:none;color:#94a3b8;font-size:14px;cursor:pointer">✕</button>'
        + '</div>'
        + '<div id="dexDockOutput" style="flex:1;overflow-y:auto;white-space:pre-wrap;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,0.45);font:12px var(--font-mono, monospace);line-height:1.45;"></div>'
        + '<form id="dexDockForm" style="display:flex;gap:8px;margin-top:6px;">'
        + '<input id="dexTermInput" type="text" placeholder="Befehl an aktives TMS-Terminal senden …" '
        + 'style="flex:1;padding:7px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.06);color:#fff;font:12.5px var(--font-mono, monospace);" />'
        + '<button type="submit" style="padding:7px 14px;border-radius:8px;border:none;background:#0284c7;color:#fff;font:600 12px var(--font-ui, sans-serif);cursor:pointer">Senden</button>'
        + '</form>';
      document.body.appendChild(dock);

      var closeBtn = document.getElementById('dexDockCloseBtn');
      if (closeBtn) closeBtn.addEventListener('click', function () { toggleDeXSplitDock(false); });

      var form = document.getElementById('dexDockForm');
      if (form) form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var inp = document.getElementById('dexTermInput');
        if (!inp || !inp.value) return;
        var activeCardId = (window.__tmsState && window.__tmsState.activeCardId) || Object.keys(byCard)[0];
        var sid = activeCardId && byCard[activeCardId];
        if (sid) {
          post('terminal:input', { sessionId: sid, data: inp.value + '\r' });
          inp.value = '';
          setTimeout(refreshDeXDockOutput, 120);
        } else if (typeof window.toast === 'function') {
          window.toast('Kein aktives Terminal verbunden');
        }
      });
    }
  }

  function refreshDeXDockOutput() {
    var out = document.getElementById('dexDockOutput');
    if (!out) return;
    var activeCardId = (window.__tmsState && window.__tmsState.activeCardId) || Object.keys(byCard)[0];
    var cs = activeCardId && window.__tmsCardState && window.__tmsCardState[activeCardId];
    if (cs && cs.lines && cs.lines.length) {
      out.textContent = cs.lines.slice(-18).join('\n');
      out.scrollTop = out.scrollHeight;
    } else {
      out.textContent = '(Bereit — Befehle unten eingeben, waehrend oben Samsung DeX laeuft)';
    }
  }

  function toggleDeXSplitDock(open) {
    ensureDeXHudDom();
    dexSplitOpen = !!open;
    var dock = document.getElementById('dexTerminalDock');
    var splitH = dexSplitOpen ? Math.min(260, Math.round((window.innerHeight || 768) * 0.34)) : 0;
    if (window.remoteState) window.remoteState.dexSplitHeight = splitH;
    if (dock) {
      dock.style.height = splitH + 'px';
      dock.style.display = dexSplitOpen ? 'flex' : 'none';
    }
    if (dexSplitOpen) refreshDeXDockOutput();
    if (typeof window.layoutRemoteStage === 'function') window.layoutRemoteStage();
    if (window.TMSRemote && typeof window.TMSRemote.setQuality === 'function' && window.remoteState && window.remoteState.running) {
      window.TMSRemote.setQuality('dex');
    }
  }
  window.toggleDeXSplitDock = toggleDeXSplitDock;

  window.TMSBridge.startDeXMonitor = function (info) {
    if (!info || !info.host) return;
    ensureDeXHudDom();
    if (!window.remoteState) window.remoteState = {};
    if (!window.remoteState.dexMode) {
      prevScreenBeforeDeX = (window.__tmsState && window.__tmsState.screen && window.__tmsState.screen !== 'remote')
        ? window.__tmsState.screen
        : 'terminals';
    }
    window.remoteState.dexMode = true;
    var dexWasActive = document.body.classList.contains('dex-mode');
    document.body.classList.add('dex-mode');
    if (!dexWasActive) toggleDeXChrome(false);
    // The stage grows to the full screen via CSS (dex-mode) and again when iOS drops the status
    // bar / safe-area padding; neither fires a resize, so the picture kept its old, smaller scale
    // and showed black bars all around. Re-measure a few times while the layout settles.
    [0, 120, 400, 900, 1600].forEach(function (ms) {
      setTimeout(function () {
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
        if (typeof window.layoutRemoteStage === 'function') window.layoutRemoteStage();
      }, ms);
    });
    window.remoteState.dexDevice = info.device || 'Samsung Galaxy Fold 7';
    var devEl = document.getElementById('dexHudDevice');
    if (devEl) devEl.textContent = window.remoteState.dexDevice;
    var hud = document.getElementById('dexHudBar');
    if (hud) hud.style.display = 'flex';

    remoteTarget = {
      id: '__dex_usb__',
      host: info.host,
      port: info.port || 8768,
      token: info.token || 'usb-dex',
      mode: 'dex',
    };
    remoteWantId = '__dex_usb__';
    if (typeof window.show === 'function') window.show('remote');
    if (window.TMSRemote && typeof window.TMSRemote.start === 'function') {
      window.TMSRemote.start('dex');
    }
    if (typeof window.setRemoteFullscreen === 'function') {
      window.setRemoteFullscreen(true);
    }
    if (typeof window.__tmsRemoteTargetReady === 'function') {
      window.__tmsRemoteTargetReady();
    }
    if (typeof window.focusDeXKeys === 'function') window.focusDeXKeys();
    // Announce once per plug-in, not on every reconnect.
    if (!dexWasActive && typeof window.toast === 'function') {
      window.toast(info.host === '127.0.0.1'
        ? '⚡ Samsung DeX per USB-C-Kabel'
        : '⚡ Samsung DeX Monitor aktiv (' + info.host + ')');
    }
  };

  window.TMSBridge.stopDeXMonitor = function () {
    if (!window.remoteState || !window.remoteState.dexMode) return;
    toggleDeXSplitDock(false);
    var hud = document.getElementById('dexHudBar');
    if (hud) hud.style.display = 'none';
    window.remoteState.dexMode = false;
    document.body.classList.remove('dex-mode', 'dex-chrome');
    var fabOff = document.getElementById('dexFab'); if (fabOff) fabOff.classList.remove('on');
    if (typeof window.blurDeXKeys === 'function') window.blurDeXKeys();
    if (window.TMSRemote && typeof window.TMSRemote.stop === 'function') {
      window.TMSRemote.stop();
    }
    var targetScreen = prevScreenBeforeDeX || 'terminals';
    if (typeof window.show === 'function') window.show(targetScreen);
    if (typeof window.toast === 'function') {
      window.toast('Samsung DeX getrennt — zurueck im Terminal');
    }
  };

  window.TMSBridge.setDeXHostStatus = function (status) {
    window.TMS_DATA.dexHost = status || null;
    var host = document.querySelector('[data-screen="servers"]');
    if (!host) return;
    var banner = document.getElementById('tmsDeXHostCard');
    if (!status) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'tmsDeXHostCard';
      banner.style.cssText = 'margin:10px 14px 4px;padding:12px 14px;border-radius:16px;'
        + 'background:rgba(14,165,233,0.12);border:1px solid rgba(56,189,248,0.38);'
        + 'color:var(--text, #f8fafc);font:12.5px var(--font-ui, sans-serif);';
      var titleRow = host.querySelector('.screen-title-row');
      if (titleRow && titleRow.nextSibling) {
        titleRow.parentNode.insertBefore(banner, titleRow.nextSibling);
      } else {
        host.insertBefore(banner, host.firstChild);
      }
    }
    var usbBadge = status.usbTethering
      ? ('🟢 USB-C aktiv (' + (status.usbIp || 'bereit') + ':' + (status.port || 8768) + ')')
      : (status.usbPlugged ? '🟡 USB-Kabel erkannt — USB-Tethering aktivieren' : '⚪ USB-Kabel ans iPad anschliessen');
    var engBadge = status.privileged
      ? '🟢 DeX-Engine bereit (One UI 8 Virtual Display)'
      : '🟡 DeX-Standby (1x per ADB/Button freischalten)';
    banner.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'
      + '<strong style="font-size:13.5px;color:#38bdf8">📱→🖥️ Samsung DeX USB-Host (iPad Monitor)</strong>'
      + '<span style="font-size:11px;opacity:0.8">' + (status.connectedClients > 0 ? ('Verbunden (' + status.width + '×' + status.height + ')') : 'Bereit') + '</span>'
      + '</div>'
      + '<div style="font-size:12px;opacity:0.9;margin-bottom:4px">' + usbBadge + '</div>'
      + '<div style="font-size:12px;opacity:0.9;margin-bottom:8px">' + engBadge + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
      + '<button type="button" id="btnDeXTether" style="padding:6px 11px;border-radius:10px;border:1px solid rgba(56,189,248,0.45);background:rgba(56,189,248,0.18);color:#fff;font:600 12px var(--font-ui, sans-serif)">1. USB-Tethering</button>'
      + '<button type="button" id="btnDeXStart" style="padding:6px 11px;border-radius:10px;border:1px solid rgba(56,189,248,0.45);background:rgba(56,189,248,0.18);color:#fff;font:600 12px var(--font-ui, sans-serif)">2. DeX-Engine starten</button>'
      + '</div>';
    var b1 = document.getElementById('btnDeXTether');
    if (b1) b1.onclick = function () { post('dex:openTether', {}); };
    var b2 = document.getElementById('btnDeXStart');
    if (b2) b2.onclick = function () { post('dex:startEngine', {}); };
  };

  post('bridge:ready', {});
})();
