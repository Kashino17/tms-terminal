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
  /**
   * Die Spaltenzahl MUSS aus der Schrift kommen, in der wir wirklich zeichnen —
   * nicht aus der, die xterm intern misst. Sonst passt eine Zeile, die der
   * Emulator für voll hält, im DOM nicht mehr in die Karte: die CSS bricht sie
   * ein ZWEITES Mal um. Genau das hat den Inhalt zerrissen und verschoben.
   */
  function measureCell(pre) {
    var probe = document.createElement('span');
    probe.className = 'term-line__text';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;';
    probe.textContent = new Array(101).join('0');
    pre.appendChild(probe);
    var r = probe.getBoundingClientRect();
    probe.remove();
    return { w: r.width / 100, h: r.height };
  }

  /** Sofort vermessen. Gibt false zurück, wenn die Karte (noch) keine Größe hat. */
  function fitNow(cardId) {
    var t = terms[cardId];
    if (!t) return false;
    var host = t.host;
    if (!host || !host.clientWidth || !host.clientHeight) return false;
    var cell = measureCell(host);
    if (!cell.w || !cell.h) return false;
    var cs = getComputedStyle(host);
    var innerW = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var innerH = host.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    var cols = Math.max(20, Math.floor(innerW / cell.w));
    var rows = Math.max(5, Math.floor(innerH / cell.h));
    if (t.term.cols !== cols || t.term.rows !== rows) {
      try { t.term.resize(cols, rows); } catch (e) { return false; }
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

  /** Alle Emulatoren leben unsichtbar hier — sie rendern nichts mehr selbst. */
  var emuHost = document.createElement('div');
  emuHost.id = 'tmsEmulators';
  document.body.appendChild(emuHost);

  function mountTerm(cardId) {
    var host = document.querySelector('.card-body[data-card-id="' + cardId + '"]');
    if (!host) return;
    var t = terms[cardId];
    if (t) { t.host = host; fitSoon(cardId); renderTerm(cardId); return; }

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

    terms[cardId] = { term: term, box: box, host: host };
    fitSoon(cardId);
    flush(cardId);
    renderTerm(cardId);
  }

  // ── Vom Emulator-Puffer in die DOM-Form des Mockups ────────────────────────
  var PALETTE = ['#1e2126','#e05561','#8cc265','#d18f52','#4aa5f0','#c162de','#42b3c2','#d7dae0',
                 '#6b7280','#ff6b74','#a5e075','#f0a45d','#66b8ff','#d67bef','#5fd0dd','#f0f2f6'];
  var MAX_ROWS = 800;   // so viel Scrollback halten wir als DOM vor
  // URLs zuerst; Pfade nur, wenn davor kein / : ~ oder Wortzeichen steht — sonst
  // wird die zweite Hälfte einer umgebrochenen URL als eigener "Pfad" erkannt.
  var URL_RE = /(https?:\/\/[^\s"'<>()]+)|((?<![\w:\/~])(?:~|\.{0,2})\/[\w.\-]+(?:\/[\w.\-]+)+)/g;

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

  /** Eine Pufferzeile -> [{text, style}] zusammengefasste Abschnitte. */
  function rowRuns(line) {
    var runs = [], cur = null;
    for (var i = 0; i < line.length; i++) {
      var cell = line.getCell(i);
      if (!cell) continue;
      var ch = cell.getChars() || ' ';
      var st = (colorOf(cell, true) || '') + '|' + (colorOf(cell, false) || '') + '|' +
               (cell.isBold() ? 'b' : '') + (cell.isDim() ? 'd' : '') +
               (cell.isItalic() ? 'i' : '') + (cell.isUnderline() ? 'u' : '') + (cell.isInverse() ? 'v' : '');
      if (!cur || cur.st !== st) { cur = { st: st, text: '', cell: cell }; runs.push(cur); }
      cur.text += ch;
    }
    return runs;
  }

  function runStyle(cell) {
    var fg = colorOf(cell, true), bg = colorOf(cell, false), css = '';
    if (cell.isInverse()) { var tmp = fg; fg = bg || '#1e2126'; bg = tmp || '#f0f2f6'; }
    if (fg) css += 'color:' + fg + ';';
    if (bg) css += 'background:' + bg + ';';
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
  function renderTerm(cardId) {
    var t = terms[cardId];
    var pre = t && t.host;
    if (!t || !pre || !pre.isConnected) return;
    // Mitten im Griff-Drag nichts neu bauen — der Output wird nachgeholt.
    if (typeof window.__tmsDragging === 'function' && window.__tmsDragging(cardId)) {
      scheduleRender(cardId);
      return;
    }

    var buf = t.term.buffer.active;
    var end = buf.baseY + t.term.rows;                 // eine Zeile hinter der letzten
    var start = Math.max(0, end - MAX_ROWS);

    // Logische Zeilen (über Umbrüche hinweg) für die Link-Erkennung.
    var rows = [];
    for (var i = start; i < end; i++) {
      var line = buf.getLine(i);
      rows.push(line ? { line: line, text: line.translateToString(true), wrapped: !!line.isWrapped } : null);
    }
    var links = {}; // rowIndex -> [{from, to, url}]
    var g = 0;
    while (g < rows.length) {
      if (!rows[g]) { g++; continue; }
      var group = [g], text = rows[g].text;
      var k = g + 1;
      var cols = t.term.cols;
      while (k < rows.length && rows[k] &&
             (rows[k].wrapped || (rows[k - 1] && rows[k - 1].text.length >= cols))) {
        group.push(k); text += rows[k].text; k++;
      }
      var m;
      URL_RE.lastIndex = 0;
      while ((m = URL_RE.exec(text))) {
        var url = m[0].replace(/[.,;:)\]]+$/, '');
        var from = m.index, to = from + url.length;
        var off = 0;
        for (var gi = 0; gi < group.length; gi++) {
          var ri = group[gi], len = rows[ri].text.length;
          var a = Math.max(from, off) - off, bEnd = Math.min(to, off + len) - off;
          if (bEnd > a) (links[ri] = links[ri] || []).push({ from: a, to: bEnd, url: url });
          off += len;
        }
      }
      g = k;
    }

    var out = [];
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var idx = out.length;
      if (!row) { out.push('<span class="term-line" data-i="' + idx + '"><span class="term-line__text"></span></span>'); continue; }
      var runs = rowRuns(row.line);
      var linkRanges = links[r] || [];
      var col = 0, html = '';
      for (var q = 0; q < runs.length; q++) {
        var run = runs[q], style = runStyle(run.cell), txt = run.text;
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
            var inner = '<span style="' + style + '">' + escapeHtml(piece) + '</span>';
            html += hit
              ? '<span class="wrapped-link" data-url="' + escapeHtml(hit.url) +
                '" data-short="' + escapeHtml(hit.url.slice(-10)) + '" role="link">' + inner + '</span>'
              : inner;
          }
          pos = stop;
        }
        col += txt.length;
      }
      out.push('<span class="term-line" data-i="' + idx + '"><span class="term-line__text">' + (html || '') + '</span></span>');
    }

    var atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
    pre.innerHTML = out.join('');
    var cs = window.__tmsCardState && window.__tmsCardState[cardId];
    if (cs) {
      pre.classList.toggle('selection-mode', !!cs.selectionMode);
      cs.lines = rows.map(function (x) { return x ? x.text : ''; }); // Kopieren/Selektion lesen daraus
      cs._renderedLen = cs.lines.length;
      if (cs.selection) {
        if (cs.selection.end >= out.length) cs.selection = null;
        else pre.querySelectorAll('.term-line').forEach(function (l, i) {
          l.classList.toggle('is-selected', i >= cs.selection.start && i <= cs.selection.end);
        });
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

  // Gedrosselt: bei Dauerausgabe nicht öfter als alle 60ms neu zeichnen.
  var renderTimers = {};
  function scheduleRender(cardId) {
    if (renderTimers[cardId]) return;
    renderTimers[cardId] = setTimeout(function () {
      renderTimers[cardId] = null;
      renderTerm(cardId);
    }, 60);
  }
  window.__tmsRenderTerm = renderTerm;

  // Nur echte Größenänderungen, und nur eine pro Ruhephase: jedes SIGWINCH lässt
  // Claude & Co. ihre Ausgabe neu zeichnen — ein Resize-Sturm erzeugt genau die
  // doppelten und zerrissenen Zeilen.
  var resizeTimers = {}, lastDims = {};
  function queueResize(cardId, cols, rows) {
    if (!cols || !rows) return;
    clearTimeout(resizeTimers[cardId]);
    resizeTimers[cardId] = setTimeout(function () {
      var sid = byCard[cardId];
      if (!sid) return;
      var key = cols + 'x' + rows;
      if (lastDims[sid] === key) return;
      lastDims[sid] = key;
      post('terminal:resize', { sessionId: sid, cols: cols, rows: rows });
    }, 250);
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
      var tile = document.querySelector('.overview-tile[data-id="' + cardId + '"] .overview-tile__body');
      if (tile) tile.innerHTML = window.__tmsPreview(cardId, 5);
      var rail = document.querySelector('.rail-item[data-id="' + cardId + '"] .rail-item__preview');
      if (rail) rail.innerHTML = window.__tmsPreview(cardId, 2);
    }, 350);
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
          fitNow(cardId); // beste verfügbare Größe — aber wir warten nicht darauf
          var tc = terms[cardId];
          post('terminal:create', {
            cardId: cardId,
            cols: (tc && tc.term.cols) || 80,
            rows: (tc && tc.term.rows) || 24,
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
  // Watch for cards appearing and disappearing — but xterm rewrites its rows on
  // every single chunk of output, and reacting to that made syncTerms re-measure
  // every card continuously. That was the scroll jank. Ignore anything that
  // happens inside a terminal.
  // Wir suchen NEUE Karten — nichts sonst. Der Karteninhalt ist unsere eigene
  // Ausgabe: darauf zu reagieren hieße, sich selbst zu triggern (und genau das
  // hat vorher jedes Neuzeichnen in eine Endlosschleife geschickt, die das
  // Vermessen der Karte nie zu Ende kommen ließ — und das Scrollen ruckeln).
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var t = records[i].target;
      if (t.nodeType === 1 && t.closest &&
          (t.closest('.card-body[data-card-id]') || t.closest('#tmsEmulators'))) continue;
      syncTerms();
      return;
    }
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', function () {
    Object.keys(terms).forEach(fitSoon);
  });

  // ── Replace the mockup's demo plumbing ────────────────────────────────────
  // Not a no-op: xterm owns the pixels, but the mockup still expects this to
  // (re)establish the per-line elements its selection UI works on.
  // Das Mockup zeichnet die Karte neu -> wir liefern die Zeilen aus dem Emulator.
  window.renderCardLines = function (id) { renderTerm(id); };
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
      var total = pre.querySelectorAll('.term-line').length;
      var idx = Math.floor((ev.clientY - base.top - padTop + pre.scrollTop) / lineH);
      idx = Math.max(0, Math.min(total - 1, idx));
      if (kind === 'start') cs.selection.start = Math.min(idx, cs.selection.end);
      else cs.selection.end = Math.max(idx, cs.selection.start);
      pre.querySelectorAll('.term-line').forEach(function (l, i) {
        l.classList.toggle('is-selected', i >= cs.selection.start && i <= cs.selection.end);
      });
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
      up:    app ? '\x1bOA' : '\x1b[A',
      down:  app ? '\x1bOB' : '\x1b[B',
      left:  app ? '\x1bOD' : '\x1b[D',
      right: app ? '\x1bOC' : '\x1b[C',
    }[key];
    if (seq) window.__tmsInput(id, seq);
    if (typeof window.flashKeyEcho === 'function') {
      var echo = { ctrlc: '^C', esc: 'Esc', tab: 'Tab', up: '↑', down: '↓', left: '←', right: '→' }[key] || key;
      window.flashKeyEcho(echo);
    }
  };
  window.clearActiveTerminal = function (id) {
    if (terms[id]) { terms[id].term.clear(); renderTerm(id); }
    if (typeof window.toast === 'function') window.toast('Geleert');
  };
  // scrollTerminalToBottom und updateJumpOrb bleiben die des Mockups: die
  // .card-body ist wieder der echte Scroller.

  /** Zeile in den Kopier-Modus nehmen. */
  function startLineSelection(line) {
    var pre = line.closest('.card-body[data-card-id]');
    if (!pre) return;
    var id = pre.getAttribute('data-card-id');
    if (!pre.classList.contains('selection-mode') && typeof window.toggleCardSelectionMode === 'function') {
      window.toggleCardSelectionMode(id, null);
    }
    if (typeof window.handleLineTap === 'function') window.handleLineTap(pre, line);
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
    startLineSelection(line);
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
    selHold = setTimeout(function () {
      if (selMoved) return;
      startLineSelection(line);
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
      exitSelection(p.getAttribute('data-card-id'));
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
        fitNow(cardId);
        // Ohne das hier hängt die Karte für immer leer da: der Server erfährt
        // nie, dass wir wieder da sind, und schickt entsprechend nichts.
        var td = dims(cardId);
        lastDims[item.sessionId] = td.cols + 'x' + td.rows;
        post('terminal:attach', { cardId: cardId, sessionId: item.sessionId, cols: td.cols, rows: td.rows });
      });
      restoring = false;
      if (typeof window.syncDockTerminal === 'function') window.syncDockTerminal();
      if (typeof window.renderTermSwitcher === 'function') window.renderTermSwitcher();
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
      fitNow(cardId);
      var bd = dims(cardId);
      lastDims[sessionId] = bd.cols + 'x' + bd.rows;
      post('terminal:attach', { cardId: cardId, sessionId: sessionId, cols: bd.cols, rows: bd.rows });
    },
    /** PTY output. */
    output: function (sessionId, chunk) {
      var cardId = cardOf(sessionId);
      if (!cardId || !terms[cardId]) { (queued[sessionId] = queued[sessionId] || []).push(chunk); return; }
      terms[cardId].term.write(chunk, function () { scheduleRender(cardId); });
      refreshPreview(cardId);
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
  var filesFilter = '';
  var filesMenuFor = null;   // Pfad, dessen Aktionsleiste offen ist
  var filesRenaming = null;  // Pfad, der gerade umbenannt wird
  var filesConfirmDel = null;
  var filesNewFolder = false;

  function fileRowHtml(f) {
    var isDir = f.type === 'dir';
    var path = f.path || '';
    if (filesRenaming === path) {
      return '<div class="tool-row">' +
        '<input class="term-input fx-input" id="fxRename" value="' + escapeHtml(f.name.replace(/\/$/, '')) + '">' +
        '<button class="btn-chip" data-fx="rename-ok">OK</button>' +
        '<button class="btn-chip" data-fx="cancel">Abbrechen</button></div>';
    }
    var head = '<button class="tool-row is-tap" ' + (isDir ? 'data-cd="' : 'data-path="') + escapeHtml(isDir ? f.name : path) + '">' +
      '<span class="tool-row__icon">' + (isDir ? '▸' : '·') + '</span>' +
      '<span class="tool-row__name">' + escapeHtml(f.name) + '</span>' +
      '<span class="tool-row__meta">' + escapeHtml(isDir ? 'öffnen' : (f.size || '') + ' · einfügen') + '</span>' +
      '</button>' +
      '<button class="fx-more" data-fx="menu" data-target="' + escapeHtml(path) + '" aria-label="Aktionen">⋯</button>';

    var menu = '';
    if (filesMenuFor === path) {
      var fav = window.__tmsFavs.indexOf(path) !== -1;
      menu = '<div class="fx-actions">' +
        (isDir ? '' : '<button class="btn-chip" data-fx="insert" data-target="' + escapeHtml(path) + '">Einfügen</button>' +
                      '<button class="btn-chip" data-fx="preview" data-target="' + escapeHtml(path) + '">Vorschau</button>' +
                      '<button class="btn-chip" data-fx="download" data-target="' + escapeHtml(path) + '">Laden</button>') +
        '<button class="btn-chip" data-fx="fav" data-target="' + escapeHtml(path) + '">' + (fav ? '★ Favorit' : '☆ Favorit') + '</button>' +
        '<button class="btn-chip" data-fx="rename" data-target="' + escapeHtml(path) + '">Umbenennen</button>' +
        '<button class="btn-chip btn-chip--danger" data-fx="del" data-target="' + escapeHtml(path) + '">' +
          (filesConfirmDel === path ? 'Wirklich löschen?' : 'Löschen') + '</button>' +
        '</div>';
    }
    return '<div class="fx-row">' + head + menu + '</div>';
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

    var html =
      '<div class="fx-head">' +
        '<button class="btn-chip" data-cd="..">▴ Aufwärts</button>' +
        '<span class="fx-path mono-text">' + escapeHtml(window.__tmsCwd) + '</span>' +
        '<button class="btn-chip" data-fx="newfolder">+ Ordner</button>' +
      '</div>' +
      '<input class="term-input fx-search" id="fxSearch" placeholder="Filtern…" value="' + escapeHtml(filesFilter) + '">' +
      favs + newFolder +
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
            btn.addEventListener('click', function () { insertIntoTerminal(btn.dataset.path, 'Pfad eingefügt'); });
          });
          body.querySelectorAll('[data-fx]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
              e.stopPropagation();
              var a = btn.dataset.fx, t = btn.dataset.target;
              if (a === 'menu') { filesMenuFor = filesMenuFor === t ? null : t; filesConfirmDel = null; rerender(); }
              else if (a === 'insert') insertIntoTerminal(t, 'Pfad eingefügt');
              else if (a === 'preview') post('files:preview', { path: t });
              else if (a === 'download') post('files:download', { path: t });
              else if (a === 'fav') { post('files:fav', { path: t }); }
              else if (a === 'rename') { filesRenaming = t; rerender(); }
              else if (a === 'rename-ok') {
                var v = document.getElementById('fxRename');
                if (v && v.value.trim()) post('files:rename', { path: filesRenaming, name: v.value.trim() });
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
    toast(okMsg || 'Eingefügt');
  }
  window.__tmsInsert = insertIntoTerminal;

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
            var sn = (window.TMS_DATA.snippets || []).find(function (x) { return x.id === btn.dataset.snippet; });
            if (sn) insertIntoTerminal(sn.cmd, 'In Terminal eingefügt');
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
        });
      },
    };
  };

  // Screenshots — the real workflow: grab an image, upload it to the server,
  // then drop its path into the terminal so the AI can actually look at it.
  // Thumbnails come straight from the server (/files/download?token=…).
  var uploadState = null; // { done, total } während des Hochladens
  var shotSelect = false; // Auswahlmodus (Long-Press auf eine Kachel)
  var shotSel = {};       // Index -> ausgewählt

  function shotRerender() {
    window.TMSBridge.setTool('screenshots', window.TMS_DATA.screenshots || []);
  }
  function shotSelectedPaths() {
    var shots = window.TMS_DATA.screenshots || [];
    return Object.keys(shotSel).filter(function (k) { return shotSel[k] && shots[k]; })
      .map(function (k) { return shots[k].path; });
  }

  window.buildScreenshotsSheet = function () {
    var shots = window.TMS_DATA.screenshots || [];
    var selCount = shotSelectedPaths().length;

    var progress = uploadState
      ? '<div class="up-progress"><div class="up-progress__bar"><span style="width:' +
          Math.round((uploadState.done / Math.max(1, uploadState.total)) * 100) + '%"></span></div>' +
        '<div class="up-progress__label">Lade hoch … ' + uploadState.done + ' von ' + uploadState.total + '</div></div>'
      : '';

    var choice = (uploadState || shotSelect) ? '' :
      '<div class="shot-choice">' +
      '<button class="shot-choice__btn" id="shotCaptureBtn">' + icon('camera', 22) + '<span>Kamera</span></button>' +
      '<button class="shot-choice__btn" id="shotPickBtn">' + icon('grid', 22) + '<span>Galerie</span><small>Fotos & Videos · bis 20</small></button>' +
      '</div>';

    // Auswahlmodus: Anhängen / Löschen / Fertig statt der Aufnahme-Knöpfe.
    var selbar = shotSelect
      ? '<div class="shot-selbar">' +
          '<button class="btn-chip" id="shotSelAttach">Anhängen (' + selCount + ')</button>' +
          '<button class="btn-chip btn-chip--danger" id="shotSelDelete">Löschen (' + selCount + ')</button>' +
          '<span class="keys-panel__spacer"></span>' +
          '<button class="btn-chip" id="shotSelDone">Fertig</button>' +
        '</div>'
      : '';

    var allBtn = (!shotSelect && shots.length)
      ? '<button class="shot-insert-all" id="shotInsertAll">Alle ' + shots.length + ' Bilder ins Terminal einfügen</button>'
      : '';

    var tiles = shots.length
      ? '<div class="shot-grid" id="shotGrid">' + shots.map(function (sh, i) {
          var bg = (sh.url && !sh.isVideo)
            ? ' style="background-image:url(\'' + sh.url + '\');background-size:cover;background-position:center"' : '';
          return '<button class="shot-tile' + (shotSel[i] ? ' is-selected' : '') + '" data-shot="' + i + '"' + bg +
            ' title="' + escapeHtml(sh.path) + '">' +
            (sh.isVideo ? '<span class="shot-tile__video">▶</span>' : '') +
            '<span class="shot-tile__check">✓</span></button>';
        }).join('') + '</div>'
      : '';

    return {
      html: progress + choice + selbar + allBtn + tiles,
      wire: function () {
        var cap = document.getElementById('shotCaptureBtn');
        if (cap) cap.addEventListener('click', function () {
          var flash = document.getElementById('shotFlash');
          if (flash) { flash.classList.add('is-flashing'); setTimeout(function () { flash.classList.remove('is-flashing'); }, 160); }
          post('shot:capture', { source: 'camera' });
        });
        var pick = document.getElementById('shotPickBtn');
        if (pick) pick.addEventListener('click', function () { post('shot:capture', { source: 'library' }); });
        var all = document.getElementById('shotInsertAll');
        if (all) all.addEventListener('click', function () {
          var paths = (window.TMS_DATA.screenshots || []).map(function (sh) { return sh.path; });
          if (paths.length) insertIntoTerminal(paths.join(' '), paths.length + ' Bilder eingefügt');
        });
        var done = document.getElementById('shotSelDone');
        if (done) done.addEventListener('click', function () { shotSelect = false; shotSel = {}; shotRerender(); });
        var att = document.getElementById('shotSelAttach');
        if (att) att.addEventListener('click', function () {
          var paths = shotSelectedPaths();
          if (!paths.length) return;
          shotSelect = false; shotSel = {};
          insertIntoTerminal(paths.join(' '), paths.length + ' Dateien eingefügt');
        });
        var del = document.getElementById('shotSelDelete');
        if (del) del.addEventListener('click', function () {
          var paths = shotSelectedPaths();
          if (!paths.length) return;
          shotSelect = false; shotSel = {};
          post('shot:delete', { paths: paths }); // React Native löscht auf dem Gerät und meldet die neue Liste
        });
        document.querySelectorAll('#toolSheetBody [data-shot]').forEach(function (tile) {
          tile.addEventListener('click', function () {
            var i = Number(tile.dataset.shot);
            if (shotSelect) { shotSel[i] = !shotSel[i]; shotRerender(); return; }
            var shot = (window.TMS_DATA.screenshots || [])[i];
            if (shot) insertIntoTerminal(shot.path, shot.isVideo ? 'Videopfad eingefügt' : 'Bildpfad eingefügt');
          });
        });
      },
    };
  };

  // Long-Press auf eine Kachel startet die Auswahl — wie in der Foto-App.
  document.addEventListener('contextmenu', function (e) {
    var tile = e.target.closest && e.target.closest('.shot-tile');
    if (!tile) return;
    e.preventDefault();
    shotSelect = true;
    shotSel[Number(tile.dataset.shot)] = true;
    if (navigator.vibrate) navigator.vibrate(8);
    shotRerender();
  });

  /** Ladefortschritt: wie viele von wie vielen Bildern schon durch sind. */
  window.TMSBridge.uploadProgress = function (done, total) {
    uploadState = (done >= total) ? null : { done: done, total: total };
    window.TMSBridge.setTool('screenshots', window.TMS_DATA.screenshots || []);
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
  /** Nach einem Upload: den Serverpfad sofort ins Terminal schreiben. */
  window.TMSBridge.insertIntoTerminal = function (text, msg) { insertIntoTerminal(text, msg); };
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

  // ══ Die Eingabezeile IST die des Terminals ═══════════════════════════════
  // Bisher ging der Text erst bei Enter raus — in Claudes eigener Eingabezeile
  // stand also nichts, während man tippte. Jetzt geht jedes Zeichen sofort an
  // die PTY. Gesendet wird die DIFFERENZ zum vorherigen Feldinhalt, nicht der
  // einzelne Tastendruck: damit kommt auch Androids Wortvorschlag korrekt an
  // (er ersetzt ganze Wörter — als Rückschritte plus neuer Text).
  var dockInput = document.getElementById('dockInput');
  var dockLast = '';

  function dockToPty() {
    var id = window.dockTargetId && window.dockTargetId();
    if (!id || !byCard[id]) { dockLast = dockInput.value; return; }
    var now = dockInput.value, prev = dockLast, i = 0;
    while (i < prev.length && i < now.length && prev[i] === now[i]) i++;
    var data = new Array(prev.length - i + 1).join('\x7f') + now.slice(i);
    dockLast = now;
    if (data) window.__tmsInput(id, data);
  }
  // Kein Stumm-Schalter: eine programmatische Wertzuweisung feuert ohnehin kein
  // input-Event. Der Schalter hat stattdessen das erste getippte Zeichen
  // verschluckt, wenn direkt nach einem Zurücksetzen losgetippt wurde.
  function dockReset() {
    dockInput.value = '';
    dockLast = '';
  }
  if (dockInput) {
    dockInput.addEventListener('input', dockToPty);
    dockInput.addEventListener('focus', function () { dockLast = dockInput.value; });
  }

  // Der Text steht schon im Terminal — beim Absenden fehlt nur noch das Enter.
  window.sendTerminalCommand = function (id, cmd) {
    if (!id) return;
    window.__tmsInput(id, '\r');
    dockReset();
  };

  // ^C und Esc verwerfen die Zeile in der Shell — dann auch bei uns.
  var origHandleTermKey = window.handleTermKey;
  window.handleTermKey = function (key, id) {
    origHandleTermKey(key, id);
    if (key === 'ctrlc' || key === 'esc') dockReset();
  };
  var origSendCtrlC = window.sendCtrlC;
  window.sendCtrlC = function (id) { origSendCtrlC(id); dockReset(); };

  // Ein anderes Terminal = eine andere Zeile: nicht die alte weiterschreiben.
  var origSyncDock = window.syncDockTerminal;
  var dockLastTarget = null;
  window.syncDockTerminal = function () {
    origSyncDock();
    var id = window.dockTargetId && window.dockTargetId();
    if (id !== dockLastTarget) { dockLastTarget = id; dockReset(); }
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
