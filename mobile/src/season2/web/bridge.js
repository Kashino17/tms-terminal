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

  /** Karte vermessen → gewünschte Spalten/Zeilen. null, wenn (noch) ohne Größe. */
  function measureFit(t) {
    var host = t.host;
    if (!host || !host.clientWidth || !host.clientHeight) return null;
    var cell = measureCell(host);
    if (!cell.w || !cell.h) return null;
    var cs = getComputedStyle(host);
    var innerW = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var innerH = host.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    return {
      cols: Math.max(20, Math.floor(innerW / cell.w)),
      rows: Math.max(5, Math.floor(innerH / cell.h)),
    };
  }

  /** SPALTEN-FREEZE: eine neue Breite wird erst übernommen, wenn sie so lange
   *  stabil ansteht. Jede Spaltenänderung reflowt den xterm-Puffer UND lässt
   *  die TUI auf das SIGWINCH ihr komplettes Bild neu malen — gegen die frisch
   *  umgebrochenen alten Zeilen entstehen genau die verklebten/gedoppelten
   *  Ausgaben. Zwischenwerte laufender Karten-Animationen (520ms-Feder) laufen
   *  hier ins Leere; nur Falten, Drehen und Schriftgröße kommen durch. */
  var COLS_SETTLE_MS = 350;
  function settleCols(cardId, want) {
    var t = terms[cardId];
    if (!t) return;
    if (t.colsWant === want && t.colsTimer) return; // Timer läuft schon auf dieses Ziel
    t.colsWant = want;
    clearTimeout(t.colsTimer);
    t.colsTimer = setTimeout(function () {
      t.colsTimer = null;
      var tt = terms[cardId];
      if (!tt) return;
      var fit = measureFit(tt);
      if (!fit || fit.cols === tt.pinCols) return;      // zurückgeschnappt — Fehlalarm
      if (fit.cols !== tt.colsWant) { settleCols(cardId, fit.cols); return; } // noch in Bewegung
      // Echte neue Breite: Ratsche zurücksetzen und EINMAL sauber umstellen.
      tt.pinCols = fit.cols;
      tt.pinRows = fit.rows;
      if (tt.term.cols !== tt.pinCols || tt.term.rows !== tt.pinRows) {
        try { tt.term.resize(tt.pinCols, tt.pinRows); } catch (e) { return; }
        invalidateRowCache(cardId);
        renderTerm(cardId);
      }
    }, COLS_SETTLE_MS);
  }

  /** Sofort vermessen. Gibt false zurück, wenn die Karte (noch) keine Größe hat. */
  function fitNow(cardId) {
    var t = terms[cardId];
    if (!t) return false;
    var fit = measureFit(t);
    if (!fit) return false;
    // ZEILEN-RATSCHE — der Kern gegen Dopplungen: Tastatur, Tastenleiste und
    // Tipp-Modus ändern die Kartenhöhe ständig, und jede Zeilen-Änderung ist
    // ein SIGWINCH, auf das Claude & Co. ihre KOMPLETTE Oberfläche neu malen —
    // der alte Frame bleibt als Leiche im Scrollback (die "Dopplungen").
    // Deshalb: rows wächst nur auf das größte gesehene Maß und schrumpft nie;
    // wird die Karte kleiner, scrollt sie einfach. Spalten sind zusätzlich
    // EINGEFROREN: ein neuer Messwert wandert über settleCols() und wird erst
    // übernommen, wenn er stabil ansteht (Falten, Drehen, Schriftgröße).
    if (t.pinCols === undefined) {
      t.pinCols = fit.cols;                    // Erstvermessung: sofort übernehmen
      t.pinRows = fit.rows;
    } else if (fit.cols !== t.pinCols) {
      settleCols(cardId, fit.cols);            // Kandidat — Puffer bleibt unangetastet
      t.pinRows = Math.max(t.pinRows || fit.rows, fit.rows);
    } else {
      if (t.colsTimer) { clearTimeout(t.colsTimer); t.colsTimer = null; } // zurückgeschnappt
      t.pinRows = Math.max(t.pinRows || fit.rows, fit.rows);
    }
    if (t.term.cols !== t.pinCols || t.term.rows !== t.pinRows) {
      try { t.term.resize(t.pinCols, t.pinRows); } catch (e) { return false; }
      // Ein Resize reflowt den Puffer: alle absoluten Zeilenindizes verschieben
      // sich — der inkrementelle Zeilen-Cache ist damit wertlos.
      invalidateRowCache(cardId);
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

    terms[cardId] = { term: term, box: box, host: host, scrollTotal: 0 };
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
  /** Baut den Inhalt einer .term-line (den inneren __text-Span) für EINE Zeile. */
  function buildRowInner(line, linkRanges) {
    if (!line) return '<span class="term-line__text"></span>';
    var runs = rowRuns(line);
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
    return '<span class="term-line__text">' + html + '</span>';
  }

  function rowWrapper(k, inner) {
    // data-b markiert Bridge-eigene Zeilen: daran erkennt der Patcher fremde
    // Rebuilds (renderCardLines des Mockups) und fällt auf den Vollaufbau zurück.
    return '<span class="term-line" data-b="1" data-i="' + k + '">' + inner + '</span>';
  }

  function invalidateRowCache(cardId) {
    var t = terms[cardId];
    if (!t) return;
    t.rc = null; t.rcMin = 0; t.dom = null; t.domStart = undefined; t.domLen = 0;
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
      var line = buf.getLine(i - trimmed);
      rows[k] = rc[i] = {
        text: line ? line.translateToString(true) : '',
        wrapped: !!(line && line.isWrapped),
        inner: null,           // wird unten gebaut, sobald die Links bekannt sind
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
      row.inner = buildRowInner(buf.getLine(start + r - trimmed), ranges);
      row.sig = sig;
    }

    var atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;

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
      for (var f = 0; f < total; f++) out[f] = rowWrapper(f, rows[f].inner);
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
        if (dom[absI] !== rows[p].inner) {
          lineEls[p].innerHTML = rows[p].inner;
          dom[absI] = rows[p].inner;
        }
      }
      // Sollte das DOM je LÄNGER sein als das Fenster (kommt regulär nicht
      // vor), überzählige Zeilen am Ende entfernen.
      while (lineEls.length > total) { delete dom[start + lineEls.length - 1]; lineEls[lineEls.length - 1].remove(); }
      if (total > keep) {
        var addHtml = '';
        for (var n = keep; n < total; n++) {
          addHtml += rowWrapper(n, rows[n].inner);
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

  // Gedrosselt: bei Dauerausgabe nicht öfter als alle 60ms neu zeichnen.
  var renderTimers = {};
  function scheduleRender(cardId) {
    if (renderTimers[cardId]) return;
    renderTimers[cardId] = setTimeout(function () {
      renderTimers[cardId] = null;
      renderTerm(cardId);
    }, 60);
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

  // SPALTEN SOFORT, ZEILEN IN RUHE. Eine Spaltenänderung MUSS im Gleichschritt
  // zur PTY (16 ms): jede Millisekunde Versatz malt die TUI für die falsche
  // Breite in einen schon umgebrochenen Puffer — die verschränkten Zeilen.
  // Reines Zeilen-Wachstum dagegen ist Umbruch-NEUTRAL, kommt aber beim
  // Karten-Aufbau als Serie (die Feder-Animation wächst die Ratsche
  // 15→24→31→38). Jeder Schritt sofort weitergereicht wäre je ein SIGWINCH,
  // auf das Claude sein komplettes Bild neu malt — die übereinander
  // gestapelten Start-Banner. Darum wandern reine Zeilen-Änderungen erst zur
  // PTY, wenn sie stabil stehen; gesendet wird der DANN aktuelle Stand.
  var resizeTimers = {}, lastDims = {};
  var ROWS_SETTLE_MS = 350;
  function queueResize(cardId, cols, rows) {
    if (!cols || !rows) return;
    var sid0 = byCard[cardId];
    var lastCols = sid0 && lastDims[sid0] ? parseInt(lastDims[sid0], 10) : null;
    var delay = lastCols === cols ? ROWS_SETTLE_MS : 16;
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
    }, delay);
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
    post('terminal:attach', { cardId: cardId, sessionId: sessionId, cols: d.cols, rows: d.rows });
  }

  // Cards appear/disappear whenever the mockup rebuilds its workspace. Follow
  // the DOM instead of duplicating that logic: an unseen card means a terminal
  // we still have to create server-side.
  var timer = null;
  var createTries = {}; // cardId -> Anläufe, die Karte vor dem Anlegen zu vermessen
  function syncTerms() {
    clearTimeout(timer);
    timer = setTimeout(function () {
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
        window.addTerminal();
        var ids = [].map.call(document.querySelectorAll('.card-body[data-card-id]'), function (el) {
          return el.getAttribute('data-card-id');
        });
        var cardId = ids.filter(function (id) { return !(id in bound) && id.indexOf('cloud-') !== 0; }).pop();
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
        // Ohne das hier hängt die Karte für immer leer da: der Server erfährt
        // nie, dass wir wieder da sind, und schickt entsprechend nichts.
        attachSized(cardId, item.sessionId);
      });
      restoring = false;
      window.toast = origToast;
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
      terms[cardId].term.write(chunk, function () { scheduleRender(cardId); });
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
  window.TMSBridge.setFilesDir = function (path, entries) {
    if (window.fsSetDir) window.fsSetDir(path, entries);
    window.__tmsCwd = path; // Sheet und Screen teilen sich den Ort
  };
  window.fsReadFile = function (path) { post('files:readRaw', { path: path }); };
  window.TMSBridge.fileContent = function (path, content, error) {
    if (window.fsSetFileContent) window.fsSetFileContent(path, content, error);
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
  var uploadState = null; // { done, total } während des Hochladens
  var shotSelect = false; // von uploadFinished zurückgesetzt (Auswahlmodus entfernt)
  var shotSel = {};       // dito

  // Nur noch die zwei Wege: direkt Kamera oder Galerie-Multiselect. Kein
  // Archiv, keine Thumbnail-Historie, kein „Alle einfügen" — nach der Auswahl
  // fügt die RN-Seite die Serverpfade in die Eingabezeile ein und
  // uploadFinished schließt die Karte automatisch.
  window.buildScreenshotsSheet = function () {
    var progress = uploadState
      ? '<div class="up-progress"><div class="up-progress__bar"><span style="width:' +
          Math.round((uploadState.done / Math.max(1, uploadState.total)) * 100) + '%"></span></div>' +
        '<div class="up-progress__label">Lade hoch … ' + uploadState.done + ' von ' + uploadState.total + '</div></div>'
      : '';

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
          post('shot:capture', { source: 'camera' });
        });
        var pick = document.getElementById('shotPickBtn');
        if (pick) pick.addEventListener('click', function () { post('shot:capture', { source: 'library' }); });
      },
    };
  };

  /** Ladefortschritt: wie viele von wie vielen Bildern schon durch sind. */
  window.TMSBridge.uploadProgress = function (done, total) {
    uploadState = (done >= total) ? null : { done: done, total: total };
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
    // Das Feld darf mitwachsen (bis 3 Zeilen) — nach dem Leeren muss es auch
    // wieder auf eine Zeile zurückfallen, sonst bleibt die Bar aufgebläht.
    if (typeof window.autoGrowInput === 'function') window.autoGrowInput(dockInput);
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

  // Tippt der Nutzer eine andere (laufende) Server-Karte an, schaltet React
  // Native die Verbindung um (Terminals des alten Servers weg, die des neuen rein).
  window.__tmsSwitchServer = function (id) { post('server:switch', { id: id }); };

  // Tippt der Nutzer den Fernzugriff-Knopf auf der Geraetekarte an: React
  // Native holt die Zugangsdaten und reicht sie ueber setRemoteTarget zurueck
  // (siehe weiter unten) — die Seite baut die Bildverbindung selbst auf.
  window.__tmsOpenRemote = function (id) { post('remote:open', { id: id }); };

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
  window.TMSBridge.setRemoteTarget = function (t) {
    remoteTarget = t;
    if (typeof window.__tmsRemoteTargetReady === 'function') window.__tmsRemoteTargetReady();
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
    delete byCard[cardId];
    bound[cardId] = 'pending';
    var t = terms[cardId];
    if (t) { try { t.term.reset(); } catch (e) {} invalidateRowCache(cardId); renderTerm(cardId); }
    if (typeof window.toast === 'function') window.toast('Session abgelaufen — starte neu');
    var d = dims(cardId);
    var sessName = (window.TMS_DATA.sessions || []).find(function (x) { return x.id === cardId; });
    post('terminal:create', { cardId: cardId, cols: d.cols, rows: d.rows, name: sessName ? sessName.name : undefined });
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
      post('terminal:attach', { cardId: cardId, sessionId: sid, cols: d.cols, rows: d.rows });
    });
  };
  /** Der Server konnte für diese Karte keine PTY anlegen. Ohne das hier bliebe
   *  sie als Geisterkarte stehen: leer, nie gebunden, beim nächsten
   *  Wiederherstellen spurlos verschwunden. Weg damit — den Grund sagt der Toast. */
  window.TMSBridge.sessionCreateFailed = function (cardId) {
    delete bound[cardId];
    delete byCard[cardId];
    if (terms[cardId]) { try { terms[cardId].term.dispose(); terms[cardId].box.remove(); } catch (e) {} delete terms[cardId]; }
    if (typeof window.removeTerminalCard === 'function') window.removeTerminalCard(cardId);
  };

  window.TMSBridge.sessionClosed = function (sessionId) {
    var cardId = cardOf(sessionId);
    if (!cardId) return;
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
    // Ueberlebt den Neuaufbau der Buehne (siehe buildRemoteScreen-Einklinkung
    // weiter unten) — sonst zeigt die frische Leiste kurz "Verbinde …", obwohl
    // die Verbindung laengst steht oder gerade an einem echten Fehler haengt.
    var lastVeil = '';
    var lastStat = '';

    var PRESETS = {
      sparsam: { maxWidth: 1280, fps: 24, bitrateKbps: 800 },
      auto:    { maxWidth: 1600, fps: 30, bitrateKbps: 1500 },
      scharf:  { maxWidth: 1920, fps: 30, bitrateKbps: 3000 },
    };

    /** Die App zeichnet den Zeiger selbst (siehe "Lokaler Zeiger" unten) —
     *  der Server laesst ihn dafuer aus dem Video weg, wo er das kann. */
    function startPayload() {
      var p = { localCursor: true };
      for (var k in PRESETS[preset]) p[k] = PRESETS[preset][k];
      return p;
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

    // ── Bildgesten: Zoom, Verschieben, langer Druck ─────────────────────────
    // `view` haelt Zoom/Versatz des Canvas innerhalb der Buehne. Bleibt hier
    // (nicht in layoutStage()) deklariert, weil applyView() es unabhaengig
    // vom Layout jederzeit neu aufs Canvas anwenden koennen muss (nach jeder
    // Geste, nicht nur nach jedem Resize).
    var view = { zoom: 1, x: 0, y: 0 };
    var pinch = null;
    var holdTimer = null;

    function applyView() {
      if (!canvas) return;
      canvas.style.transformOrigin = 'center center';
      canvas.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.zoom + ')';
      renderCursor();
    }

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

    function cursorLayer() {
      var stage = document.getElementById('remoteStage');
      if (!stage) return null;
      var layer = document.getElementById('remoteCursorLayer');
      if (!layer) {
        // Liegt exakt auf dem Canvas (gleiche Box, gleiche Transformation),
        // folgt also jedem Zoom und Verschieben von selbst.
        layer = document.createElement('div');
        layer.id = 'remoteCursorLayer';
        layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;transform-origin:center center;z-index:1';
        layer.innerHTML = '<div id="remoteCursor" style="position:absolute;left:0;top:0;line-height:0;transform-origin:0 0;display:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.45))">' + CURSOR_SVG + '</div>';
        // Den Canvas DIESER Buehne nehmen — `canvas` kann nach einem Neuaufbau
        // kurz noch auf das alte Element zeigen, und insertBefore mit einem
        // fremden Bezugsknoten wirft.
        var cv = stage.querySelector('canvas');
        stage.insertBefore(layer, cv ? cv.nextSibling : null);
      }
      return layer;
    }

    function renderCursor() {
      var layer = cursorLayer();
      if (!layer) return;
      var el = document.getElementById('remoteCursor');
      var st = window.remoteState;
      var show = !!(st.localCursor && st.running && cursor.known && st.w);
      el.style.display = show ? 'block' : 'none';
      if (!show) return;
      layer.style.transform = canvas ? canvas.style.transform : '';
      var stage = document.getElementById('remoteStage');
      // Bildlage exakt wie object-fit:contain sie legt — fitRect rundet auf
      // ganze Pixel, das waeren bis zu 0,5 px Versatz.
      var sc = Math.min(stage.clientWidth / st.w, stage.clientHeight / st.h);
      var box = { w: st.w * sc, h: st.h * sc };
      box.x = (stage.clientWidth - box.w) / 2;
      box.y = (stage.clientHeight - box.h) / 2;
      // Echte Groesse: der Mac-Pfeil ist ~20 Punkte hoch. Frueher mindestens
      // 16 px — auf dem Fold 2-4x groesser als das Original, und ein grosser
      // Pfeil taeuscht vor, man zeige auf etwas, das die Spitze gar nicht trifft.
      var ptToPx = box.w / (st.w / (st.scale || 1));
      var h = Math.max(9, 20 * ptToPx);
      el.style.width = (h * 12 / 18) + 'px';
      el.style.height = h + 'px';
      el.style.transform = 'translate(' + (box.x + cursor.x * box.w) + 'px,' + (box.y + cursor.y * box.h) + 'px) scale(' + (1 / view.zoom) + ')';
    }

    /** Vorhersage: was die App gerade schickt, sieht sie sofort. */
    function predictCursor(ev) {
      var st = window.remoteState;
      if (!st.localCursor || !st.w) return;
      if (ev.t === 'd') {
        var ptsW = st.w / (st.scale || 1), ptsH = st.h / (st.scale || 1);
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

    function quietMs() { return Math.max(300, linkRttMs * 2 + 100); }

    /** Nach der letzten eigenen Bewegung (plus Hin- und Rueckweg) die echte Position uebernehmen. */
    function armSettle() {
      if (cursor.settleTimer) clearTimeout(cursor.settleTimer);
      cursor.settleTimer = setTimeout(settleCursor, quietMs() + 20);
    }

    function settleCursor() {
      cursor.settleTimer = null;
      var wait = quietMs() - (Date.now() - cursor.lastLocalAt);
      if (wait > 0) { cursor.settleTimer = setTimeout(settleCursor, wait + 20); return; }
      if (!cursor.srv) return;
      cursor.x = cursor.srv.x; cursor.y = cursor.srv.y; cursor.known = true;
      renderCursor();
    }

    /** Echte Position vom Mac — gilt sofort, solange die eigene Bewegung ruht, sonst beim Nachziehen. */
    function serverCursor(p) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return;
      cursor.srv = { x: p.x, y: p.y };
      var quiet = Date.now() - cursor.lastLocalAt > quietMs();
      if (cursor.known && !quiet) { if (!cursor.settleTimer) armSettle(); return; }
      cursor.x = p.x; cursor.y = p.y; cursor.known = true;
      renderCursor();
    }

    /**
     * Gesten auf dem Bild selbst: Aufziehen zoomt (bis 3×, siehe clampZoom im
     * Mockup), ein Finger bei Zoom>1 verschiebt (clampPan haelt es im
     * Rahmen), Doppeltipp springt zwischen 1× und 2×, und ein langer Druck
     * versetzt den Zeiger dorthin — die einzige Moeglichkeit, ihn schnell ueber
     * eine weite Strecke zu setzen, denn das Trackpad braucht dafuer mehrere
     * Wischer.
     *
     * Zustand JE Zeiger (Map von pointerId), nicht global — sonst verrechnet
     * sich ein Zwei-Finger-Zoom bei ueber Kreuz bewegten Fingern, und das
     * Abheben eines beliebigen Fingers wuerde die Geste des anderen killen.
     */
    function wireStageGestures() {
      var stage = document.getElementById('remoteStage');
      if (!stage || stage.dataset.wired === '1') return;
      stage.dataset.wired = '1';
      stage.style.touchAction = 'none';

      var points = new Map();
      var lastTap = 0;

      stage.addEventListener('pointerdown', function (e) {
        if (window.remoteState.fullscreen) return;      // dort gehoert alles der Maus
        // startX/startY sind der Aufsetzpunkt und bleiben fuer die gesamte Geste
        // unveraendert (siehe holdShouldAbort im Mockup) — x/y sind die jeweils
        // LETZTE Position und wandern bei jedem pointermove mit (fuer die
        // Verschiebe-/Pinch-Deltas weiter unten).
        points.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
        if (points.size === 2) {
          var p = Array.from(points.values());
          pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), zoom: view.zoom };
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
          return;
        }
        // Langer Druck aufs Bild: Zeiger dorthin — sendet eine Zeigerbewegung,
        // keinen Klick, es gibt also nichts, was haengen bleiben koennte.
        var start = { x: e.clientX, y: e.clientY };
        holdTimer = setTimeout(function () {
          holdTimer = null;
          var box = stageBox();
          if (!box) return;
          var n = window.toStageNormalized(start.x, start.y, box);
          if (n) {
            window.TMSRemote.input({ t: 'm', x: n.x, y: n.y });
            if (navigator.vibrate) navigator.vibrate(12);
          }
        }, 400);
      });

      stage.addEventListener('pointermove', function (e) {
        if (!points.has(e.pointerId)) return;
        var prev = points.get(e.pointerId);
        var dx = e.clientX - prev.x;
        var dy = e.clientY - prev.y;
        points.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: prev.startX, startY: prev.startY });
        // Entfernung zum AUFSETZPUNKT dieses Fingers (holdShouldAbort im
        // Mockup), NICHT die aufsummierte Pfadlaenge seit dem Aufsetzen — die
        // Summe misst zurueckgelegte Strecke, nicht Abweichung vom Start: ein
        // Finger, der ruhig aufliegt, aber leicht zittert, sammelt darueber
        // in 400ms genug Mikroschritte, um die Schwelle grundlos zu reissen,
        // und der lange Druck stuerbe bei ruhiger Hand seltener durch als bei
        // unruhiger. Ueber die Entfernung zum Start bricht nur eine ECHTE
        // Bewegung ab; Zittern oder Hin-und-Herwischen zurueck zum Ausgangs-
        // punkt bricht bewusst nicht ab (harmloser als der umgekehrte Fehler).
        if (holdTimer && window.holdShouldAbort(prev.startX, prev.startY, e.clientX, e.clientY, 8)) {
          clearTimeout(holdTimer); holdTimer = null;
        }

        if (pinch && points.size === 2) {
          var pp = Array.from(points.values());
          var d = Math.hypot(pp[0].x - pp[1].x, pp[0].y - pp[1].y);
          view.zoom = window.clampZoom(pinch.zoom * (d / pinch.d));
        } else if (points.size === 1 && view.zoom > 1) {
          var r = stage.getBoundingClientRect();
          view.x = window.clampPan(view.x + dx, view.zoom, r.width);
          view.y = window.clampPan(view.y + dy, view.zoom, r.height);
        }
        applyView();
      });

      function up(e) {
        points.delete(e.pointerId);
        if (points.size < 2) pinch = null;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        // Vollbild gehoert der angeschlossenen Maus: ein echter Doppelklick
        // damit bubbelt bis hierher genauso wie ein Doppeltipp (pointerdown
        // wurde oben zwar schon uebersprungen, aber "up" laeuft trotzdem) —
        // ohne diese Bedingung wuerde er faelschlich den Bild-Zoom umschalten.
        if (window.remoteState.fullscreen) return;

        var now = Date.now();
        if (now - lastTap < 300) {                      // Doppeltipp
          view.zoom = view.zoom > 1 ? 1 : 2;
          view.x = 0; view.y = 0;
          applyView();
          lastTap = 0;
        } else {
          lastTap = now;
        }
      }
      stage.addEventListener('pointerup', up);
      stage.addEventListener('pointercancel', up);
    }

    /** Die Buehne bekommt genau die Hoehe, die das Bild seitenrichtig braucht. */
    function layoutStage() {
      var stage = document.getElementById('remoteStage');
      if (!stage || !window.remoteState.w) return;
      var w = stage.clientWidth || stage.getBoundingClientRect().width;
      // Hoehe begrenzen: die Bedienleiste darunter (Tastatur/Trackpad) braucht
      // ihren Platz. Nach der Breite allein bemessen war das Bild auf dem
      // aufgeklappten Fold ~550 px hoch — die Tastatur rutschte aus dem
      // Bildschirm unter die Navigationsleiste. Im Vollbild gilt das nicht.
      var maxH = w * 2;
      var host = stage.closest('[data-screen="remote"]');
      if (host && !window.remoteState.fullscreen) {
        var cs = getComputedStyle(host);
        var used = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        var gap = parseFloat(cs.rowGap || cs.gap) || 0;
        var n = 0;
        Array.prototype.forEach.call(host.children, function (el) {
          if (el === stage || el.id === 'remoteBar' || el.id === 'remoteIme') return;
          var cs2 = getComputedStyle(el);
          // Ausgeblendetes und Schwebendes (Kreis, sein Menue) nimmt keinen Platz weg.
          if (cs2.display === 'none' || cs2.position === 'fixed' || cs2.position === 'absolute') return;
          used += el.getBoundingClientRect().height; n++;
        });
        used += gap * (n + 1);
        var avail = host.clientHeight - used;
        // Tastatur: ihre echte Hoehe (Reihen in Handy-Tastenhoehe) + ein Streifen
        // Mini-Trackpad; Trackpad-Seite: mindestens 170 px Wischflaeche.
        var keysEl = document.getElementById('remoteKeys');
        var minBar = window.remoteState.page === 'keys'
          ? (keysEl ? keysEl.scrollHeight : 260) + 90
          : 170;
        if (avail - minBar > 80) maxH = Math.min(maxH, avail - minBar);
      }
      // window.-Vorsatz ist Pflicht: der Mockup-Code liegt in einer Kapsel, in
      // die bridge.js nicht hineinsieht (siehe Ausfuhr-Zeilen in Aufgabe 11).
      var fit = window.fitRect(window.remoteState.w, window.remoteState.h, w, maxH);
      var box = { x: 0, y: 0, w: w, h: Math.min(maxH, fit.h) };
      stage.style.height = box.h + 'px';
      if (canvas) { canvas.width = window.remoteState.w; canvas.height = window.remoteState.h; }
      // Vollbild gehoert der angeschlossenen Hardware: ein von Fingern liegen
      // gebliebener Zoom/Versatz wuerde die absolute Mausabbildung weiter
      // unten (stageBox()) verfaelschen, die von einem unverzerrten Bild
      // ausgeht — darum hier zurueckgesetzt, sobald die Buehne (neu) vermessen
      // wird, waehrend Vollbild an ist.
      if (window.remoteState.fullscreen) { view.zoom = 1; view.x = 0; view.y = 0; }
      else {
        // Zoom/Versatz ueberleben bewusst einen Bildschirmwechsel (Verlassen
        // und Zurueckkommen an den Fernzugriff baut die Buehne komplett neu,
        // siehe buildRemoteScreen-Einklinkung oben) — anders als beim
        // Vollbild-Eintritt gibt es hier keinen Korrektheitsgrund, den Zoom
        // wegzuwerfen (clampZoom haengt nicht von der Buehnengroesse ab,
        // bleibt also so oder so gueltig), und ein weggeworfener Zoom waere
        // fuer die Nutzerin nur eine unbegruendete Ueberraschung. Der Versatz
        // dagegen HAENGT von der Buehnengroesse ab (clampPan bekommt sie als
        // Parameter) — wurde die Buehne inzwischen anders vermessen (Drehung,
        // anderer Container), kann ein alter Versatz ausserhalb des gueltigen
        // Bereichs liegen und das Bild schief sitzen lassen. Darum hier mit
        // der vorhandenen Klemmfunktion gegen die frisch vermessene Buehne
        // nachgezogen (w/box.h statt einem erneuten getBoundingClientRect,
        // sie sind gerade eben aus derselben Messung hervorgegangen).
        view.x = window.clampPan(view.x, view.zoom, w);
        view.y = window.clampPan(view.y, view.zoom, box.h);
      }
      applyView();
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
    var realBuildRemoteScreen = window.buildRemoteScreen;
    window.buildRemoteScreen = function () {
      if (typeof realBuildRemoteScreen === 'function') realBuildRemoteScreen();
      canvas = document.getElementById('remoteCanvas');
      ctx = canvas ? canvas.getContext('2d') : null;
      layoutStage();
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
      if (view.length < 6 || (view[0] & 0x7f) !== 0x01) return;
      var keyframe = (view[0] & 0x80) !== 0;
      var ts = (view[1] << 24 | view[2] << 16 | view[3] << 8 | view[4]) >>> 0;
      // Quittung sofort beim Empfang: daraus misst der Server, wie viel sich
      // auf der Leitung staut, und verwirft lieber Bilder, als sekundenlang
      // hinterherzulaufen (server/src/remote/flow.ts).
      if (ws && ws.readyState === 1) ws.send('{"type":"remote:ack","payload":{"ts":' + ts + '}}');
      if (!ensureDecoder()) return;
      // Vor dem ersten Vollbild ist jedes Zwischenbild sinnlos — der Dekoder
      // haette keinen Ausgangspunkt und zeichnete graue Kloetze.
      if (decoder.state !== 'configured') return;
      // Kommt der Dekoder nicht hinterher, lieber aufs naechste Vollbild
      // springen als mit wachsendem Rueckstand weiterzuzeichnen. Ein
      // verworfenes Zwischenbild entwertet alle folgenden — also bis zum
      // Vollbild nichts mehr dekodieren und eines anfordern.
      if (!keyframe && decoder.decodeQueueSize > 2) decoder.__gotKey = false;
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
          window.remoteState.localCursor = !!msg.payload.localCursor;
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
          stat(msg.payload.fps + ' fps · ' + msg.payload.rttMs + ' ms');
          linkRttMs = msg.payload.rttMs || 0;
          break;
        case 'remote:cursor':
          serverCursor(msg.payload);
          break;
        case 'remote:stopped':
          window.remoteState.running = false;
          renderCursor();
          veil('Beendet');
          break;
        case 'remote:error':
          window.remoteState.running = false;
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
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = function () {
        // Neue Verbindung, Zeigerposition unbekannt. NICHT erst bei
        // remote:started zuruecksetzen: die erste Positionsmeldung des Macs
        // kommt VOR remote:started an und waere sonst gleich wieder vergessen.
        cursor.known = false;
        cursor.srv = null;
        if (cursor.settleTimer) { clearTimeout(cursor.settleTimer); cursor.settleTimer = null; }
        ws.send(JSON.stringify({ type: 'remote:start', payload: startPayload() }));
        veil('Verbinde …');
      };
      ws.onmessage = function (e) {
        if (typeof e.data === 'string') { try { onControl(JSON.parse(e.data)); } catch (err) {} }
        else onBinary(e.data);
      };
      ws.onclose = function () {
        ws = null;
        if (decoder) { try { decoder.close(); } catch (e) {} decoder = null; }
        window.remoteState.running = false;
        renderCursor();
        // N1: waehrend suspend() darf hier NIE ein Wiederverbindungs-Zeitgeber
        // entstehen — wantRunning bleibt bei suspend() absichtlich `true`
        // (siehe suspended-Deklaration oben), also reicht dessen Pruefung
        // allein nicht mehr.
        if (!wantRunning || suspended) return;
        // Nie aufgeben: die Verbindung faellt unterwegs staendig kurz weg.
        retry = Math.min(retry + 1, 6);
        veil('Verbindung verloren — neuer Versuch …');
        retryTimer = setTimeout(connect, Math.min(500 * retry, 4000));
      };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
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
    function maybeConnect() {
      if (!wantRunning || ws) return;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      connect();
    }
    // Von setRemoteTarget (oben in dieser Datei) aufgerufen, sobald React
    // Native die Zugangsdaten liefert — das ist der eigentliche Fix fuer C2.
    window.__tmsRemoteTargetReady = maybeConnect;

    window.TMSRemote = {
      start: function (which) {
        preset = which || preset;
        wantRunning = true;
        suspended = false; // ein expliziter Start raeumt einen etwaigen Rest auf
        if (typeof window.buildRemoteScreen === 'function' && !document.getElementById('remoteStage')) {
          window.buildRemoteScreen();
        }
        // Ausserhalb des if: die Buehne steht in der Praxis meist schon (der
        // Aufrufer zeigt den Bildschirm typischerweise vor start()), darum
        // wuerde eine Verschachtelung im if oben die Gesten nie verdrahten.
        // wireStageGestures() ist ueber stage.dataset.wired selbst dagegen
        // abgesichert, mehrfach am selben Element zu haengen.
        wireStageGestures();
        maybeConnect();
      },
      stop: function () {
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
        suspended = false;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'remote:stop' }));
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
        if (decoder) { try { decoder.close(); } catch (e) {} decoder = null; }
        window.remoteState.running = false;
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
        suspended = true;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'remote:stop' }));
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
        if (decoder) { try { decoder.close(); } catch (e) {} decoder = null; }
        window.remoteState.running = false;
      },
      /** Setzt nur fort, was vorher lief (wantRunning) — nach einem
       *  expliziten "Trennen" bleibt das ein No-op, siehe suspend() oben. */
      resume: function () { suspended = false; maybeConnect(); },
      /** Stufenwechsel = neu starten: ffmpeg auf Windows kann die Bitrate nicht im Lauf aendern. */
      setQuality: function (which) {
        preset = which;
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
    };

    // Der Mockup ruft das beim Vollbildwechsel und nach Gesten auf, kommt aber
    // nicht in diese Kapsel hinein — deshalb ausdruecklich nach aussen geben.
    window.layoutRemoteStage = layoutStage;
    window.addEventListener('resize', layoutStage);

    // ── Vollbild: angeschlossene Tastatur und Maus ──────────────────────────
    // Manuell umgeschaltet (siehe window.setRemoteFullscreen im Mockup) — hier
    // wird nur noch weitergeleitet, solange window.remoteState.fullscreen an ist.

    /** Rechteck des Bildes innerhalb der Buehne, in Bildschirmkoordinaten. */
    function stageBox() {
      var stage = document.getElementById('remoteStage');
      if (!stage || !window.remoteState.w) return null;
      var r = stage.getBoundingClientRect();
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

    // Angeschlossene Maus: absolute Abbildung ueber dem Bild — der PC-Zeiger
    // steht dort, wo der Android-Zeiger ueber dem Bild steht (siehe
    // toStageNormalized() im Mockup fuer die Begruendung).
    document.addEventListener('pointermove', function (e) {
      if (!window.remoteState.fullscreen || e.pointerType !== 'mouse') return;
      var box = stageBox();
      if (!box) return;
      var p = window.toStageNormalized(e.clientX, e.clientY, box);
      if (p) window.TMSRemote.input({ t: 'm', x: p.x, y: p.y });
    });

    document.addEventListener('pointerdown', function (e) {
      if (!window.remoteState.fullscreen || e.pointerType !== 'mouse') return;
      if (e.target.closest && e.target.closest('#remoteExit')) return;   // Abzeichen bleibt der Rueckweg, nicht Teil der Fernsteuerung
      // Wie bei pointermove ans Bildrechteck gebunden: ein Klick im schwarzen
      // Rand neben dem Bild darf keinen Druck anfangen, sonst landet er an
      // der zuletzt bekannten Zeigerstelle statt dort, wo der Nutzer hinsieht.
      var box = stageBox();
      if (!box || e.clientX < box.x || e.clientX > box.x + box.w || e.clientY < box.y || e.clientY > box.y + box.h) return;
      e.preventDefault();
      var b = e.button === 2 ? 'r' : e.button === 1 ? 'm' : 'l';
      heldButtons[b] = true;
      window.TMSRemote.input({ t: 'b', b: b, d: true });
    });
    document.addEventListener('pointerup', function (e) {
      if (!window.remoteState.fullscreen || e.pointerType !== 'mouse') return;
      var b = e.button === 2 ? 'r' : e.button === 1 ? 'm' : 'l';
      // Bewusst NICHT ans Bildrechteck gebunden: ein Druck, der innerhalb
      // begonnen hat, muss sein Loslassen auch dann bekommen, wenn der
      // Zeiger inzwischen ausserhalb ist — sonst bleibt die Maustaste
      // haengen (in diesem Vorhaben schon dreimal gefunden). heldButtons
      // haelt fest, was hier tatsaechlich als gedrueckt gilt; ein Loslassen
      // ohne zugehoerigen Druck (nie im Bild begonnen) wird nicht gesendet.
      if (!heldButtons[b]) return;
      delete heldButtons[b];
      window.TMSRemote.input({ t: 'b', b: b, d: false });
    });
    document.addEventListener('contextmenu', function (e) {
      if (window.remoteState.fullscreen) e.preventDefault();
    });
    document.addEventListener('wheel', function (e) {
      if (!window.remoteState.fullscreen) return;
      e.preventDefault();
      window.TMSRemote.input({ t: 's', dx: Math.round(-e.deltaX / 20), dy: Math.round(-e.deltaY / 20) });
    }, { passive: false });

    // Angeschlossene Tastatur: Tasten abfangen, bevor der Browser sie deutet.
    function forwardKey(e, down) {
      if (!window.remoteState.fullscreen) return;
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

  post('bridge:ready', {});
})();
