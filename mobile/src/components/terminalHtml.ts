import { XTERM_CSS, XTERM_XTERM, XTERM_FIT, XTERM_WEBLINKS, XTERM_CANVAS } from '../assets/xtermBundle';

// Build HTML with xterm.js scripts inlined (no CDN dependency).
// Library scripts are injected via string concatenation to avoid template literal escaping issues.
const TERMINAL_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #0F172A; }

  #terminal-container { width: 100%; height: 100%; position: relative; }
  #terminal { width: 100%; height: 100%; }
  .xterm { padding: 4px; }
  .xterm-viewport::-webkit-scrollbar { width: 4px; }
  .xterm-viewport::-webkit-scrollbar-thumb { background: #475569; border-radius: 2px; }
  .xterm-viewport { -webkit-overflow-scrolling: touch; }

  /* Prevent native long-press context menu / callout on terminal */
  #terminal { -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; }

  /* Row selection markers */
  .row-marker {
    position: absolute; left: 0; right: 0; height: 2px;
    display: none; z-index: 20; pointer-events: none;
  }
  .row-marker-s { background: #22c55e; box-shadow: 0 0 8px rgba(34,197,94,0.7); }
  .row-marker-e { background: #3b82f6; box-shadow: 0 0 8px rgba(59,130,246,0.7); }

  #shadow-input {
    position: fixed; opacity: 0; width: 1px; height: 1px;
    top: 0; left: 0; z-index: 100;
    border: none; outline: none; padding: 0; font-size: 16px;
    caret-color: transparent; background: transparent; color: transparent;
    -webkit-tap-highlight-color: transparent;
    -webkit-appearance: none;
  }
</style>
<style>` + XTERM_CSS + `</style>
</head>
<body>

<div id="terminal-container">
  <div id="terminal"></div>
  <input id="shadow-input" type="text"
    autocomplete="off"
    autocapitalize="none" inputmode="text"/>
</div>

<script>` + XTERM_XTERM + `<\/script>
<script>` + XTERM_FIT + `<\/script>
<script>` + XTERM_WEBLINKS + `<\/script>
<script>` + XTERM_CANVAS + `<\/script>
<script>
(function() {

  var SEQ = {
    esc:   '\\x1b',  tab:   '\\t',    ctrlc: '\\x03',
    up:    '\\x1b[A', down:  '\\x1b[B', right: '\\x1b[C', left:  '\\x1b[D',
    home:  '\\x1b[H', end:   '\\x1b[F', pgup:  '\\x1b[5~', pgdn:  '\\x1b[6~',
    bs:    '\\x7f',  enter: '\\r',
  };

  /* ── Terminal ──────────────────────────────────────── */
  var term = new window.Terminal({
    cursorBlink: true, cursorStyle: 'bar', fontSize: 14,
    fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace",
    theme: {
      background:'#0F172A', foreground:'#F8FAFC', cursor:'#F8FAFC',
      selectionBackground:'rgba(59,130,246,0.45)', black:'#45475a', red:'#f38ba8',
      green:'#a6e3a1', yellow:'#f9e2af', blue:'#89b4fa', magenta:'#f5c2e7',
      cyan:'#94e2d5', white:'#bac2de', brightBlack:'#585b70',
      brightRed:'#f38ba8', brightGreen:'#a6e3a1', brightYellow:'#f9e2af',
      brightBlue:'#89b4fa', brightMagenta:'#f5c2e7', brightCyan:'#94e2d5',
      brightWhite:'#a6adc8'
    },
    allowProposedApi: true, scrollback: 2000, disableStdin: false,
    fastScrollModifier: 'none',
    smoothScrollDuration: 0,
    scrollSensitivity: 2,
    fastScrollSensitivity: 8,
  });
  var fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
  term.open(document.getElementById('terminal'));
  // Canvas renderer — draws on <canvas> instead of DOM elements, dramatically faster scrolling
  if (window.CanvasAddon) {
    try { term.loadAddon(new window.CanvasAddon.CanvasAddon()); } catch(e) {}
  }
  /* ── Smart Path Links (underlined, clickable) ───────────────── */
  // Combined regex (single pass instead of 3 separate patterns)
  var PATH_RE = /((?:\\/(?:Users|home|tmp|etc|var|opt|usr|mnt|root)[^\\s:,;'"\\)\\]]+)|(?:~\\/[^\\s:,;'"\\)\\]]+)|(?:(?:\\.\\/|\\.\\.\\/)[^\\s:,;'"\\)\\]]+))/g;
  // Cache link results per line to avoid re-computing during scroll
  var linkCache = {};
  var linkCacheSize = 0;
  term.registerLinkProvider({
    provideLinks: function(lineNumber, callback) {
      // Return cached result if available
      var cacheKey = lineNumber + ':' + term.buffer.active.viewportY;
      if (linkCache[cacheKey] !== undefined) { callback(linkCache[cacheKey]); return; }

      var line = term.buffer.active.getLine(lineNumber - 1);
      if (!line) { callback(undefined); return; }
      var text = line.translateToString(true);

      var links = [];
      var match;
      PATH_RE.lastIndex = 0;
      while ((match = PATH_RE.exec(text)) !== null) {
        var startX = match.index;
        var path = match[1].replace(/[.,;:!?)\\}\\]]+$/, '');
        (function(linkPath, sx) {
          links.push({
            range: { start: { x: sx + 1, y: lineNumber }, end: { x: sx + linkPath.length, y: lineNumber } },
            text: linkPath,
            activate: function() { sendToRN({ type: 'path_link_clicked', data: linkPath }); }
          });
        })(path, startX);
      }
      var result = links.length > 0 ? links : undefined;
      // Cache with eviction at 500 entries
      if (linkCacheSize > 500) { linkCache = {}; linkCacheSize = 0; }
      linkCache[cacheKey] = result;
      linkCacheSize++;
      callback(result);
    }
  });

  fitAddon.fit();
  term.attachCustomKeyEventHandler(function() { return false; });

  // Selection → notify RN so it can show the copy bar (only when NOT in select mode)
  term.onSelectionChange(function() {
    if (!selMode) sendToRN({ type: 'selection', text: term.getSelection() });
  });

  /* ── RN bridge ─────────────────────────────────────── */
  function sendToRN(msg) {
    if (window.ReactNativeWebView)
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  function sendKey(seq) { sendToRN({ type: 'input', data: seq }); }

  /* Terminal tap → focus keyboard (not in select mode) */
  // Use touchstart/touchend to detect a genuine stationary tap (not a scroll).
  // The native 'click' event fires even after small scrolls on mobile,
  // which was causing focusShadow() → scrollToBottom() during scroll attempts.
  var tapFocusX = 0, tapFocusY = 0, tapFocusT = 0;
  document.getElementById('terminal').addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) {
      tapFocusX = e.touches[0].clientX;
      tapFocusY = e.touches[0].clientY;
      tapFocusT = Date.now();
    }
  }, { passive: true });
  document.getElementById('terminal').addEventListener('touchend', function(e) {
    if (selMode || isPinching) return;
    var t = e.changedTouches[0];
    if (!t) return;
    // Only count as tap if finger barely moved and was brief
    if (Math.abs(t.clientX - tapFocusX) > 10 || Math.abs(t.clientY - tapFocusY) > 10) return;
    if (Date.now() - tapFocusT > 400) return;
    focusShadow();
  }, { passive: true });

  /* ── Shadow input (soft keyboard) ─────────────────── */
  var shadowInput = document.getElementById('shadow-input');
  var prevValue   = '';
  var isComposing = false;

  function focusShadow() {
    // Use preventScroll to avoid Android WebView haptic feedback on focus
    shadowInput.focus({ preventScroll: true });
    shadowInput.setSelectionRange(shadowInput.value.length, shadowInput.value.length);
    // Sync prevValue — Samsung IME may have silently changed the value.
    // Without this, the next diff sees stale prevValue → phantom deletions.
    prevValue = shadowInput.value;
    cancelPendingBs();
    // Only scroll to bottom if user hasn't scrolled up — otherwise
    // tapping to focus the keyboard would yank the viewport away
    // from what they're reading in scrollback.
    if (!userScrolledUp) {
      term.scrollToBottom();
    }
  }

  /* Physical keyboard (emulator / Bluetooth) */
  document.addEventListener('keydown', function(e) {
    // Refocus shadowInput if it lost focus — without focus, no input events fire
    if (document.activeElement !== shadowInput && !selMode) {
      shadowInput.focus({ preventScroll: true });
    }
    if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      cancelPendingBs();
      if (isComposing) { isComposing = false; }
      shadowInput.value = ''; prevValue = '';
      sendKey(SEQ.enter);
      return;
    }
    // Skip IME-processed events (keyCode 229 = "handled by IME").
    // Samsung sometimes sends e.key='Backspace' with keyCode 229 —
    // physicalKey would catch it and send a backspace, but the input
    // handler ALSO processes the deletion via diff → double backspace.
    if (isComposing || e.isComposing || e.keyCode === 229) return;
    var s = physicalKey(e);
    if (s) { e.preventDefault(); sendKey(s); }
  });

  function physicalKey(e) {
    if (e.key === 'ArrowUp')    return SEQ.up;
    if (e.key === 'ArrowDown')  return SEQ.down;
    if (e.key === 'ArrowRight') return SEQ.right;
    if (e.key === 'ArrowLeft')  return SEQ.left;
    if (e.key === 'Enter')      return SEQ.enter;
    // NOTE: Backspace deliberately NOT handled here.
    // Samsung soft keyboard sometimes sends real keydown Backspace events
    // (keyCode 8, not 229). If we handle it here AND the browser also
    // processes it (changing shadowInput), the diff handler fires too →
    // DOUBLE backspace on every press → "stuck delete" effect.
    // Backspace is handled exclusively by:
    //  - diff handler (input event, when field has text)
    //  - beforeinput handler (when field is empty)
    if (e.key === 'Tab')        return SEQ.tab;
    if (e.key === 'Escape')     return SEQ.esc;
    if (e.key === 'Home')       return SEQ.home;
    if (e.key === 'End')        return SEQ.end;
    if (e.key === 'PageUp')     return SEQ.pgup;
    if (e.key === 'PageDown')   return SEQ.pgdn;
    if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
      var c = e.key.toLowerCase().charCodeAt(0) - 96;
      if (c >= 1 && c <= 26) return String.fromCharCode(c);
    }
    return null;
  }

  // ── Diff-based input (NO preventDefault) ────────────────────────────
  // CRITICAL: Do NOT call preventDefault() on regular beforeinput events.
  // Samsung IME detects blocked input and STOPS firing beforeinput/input
  // events entirely — only keydown(Unidentified,229) continues to fire,
  // making all input completely non-functional.
  //
  // Instead: let the browser handle field updates naturally, then use a
  // common-prefix diff (prevValue vs cur) to detect insertions, deletions,
  // AND replacements (autocorrect).  Deferred backspaces (50ms) protect
  // against Samsung prediction cleanup.  Field cleared at 60 chars.

  var pendingBs = 0;
  var pendingBsTimer = null;
  var pendingDeletedStr = '';

  function flushPendingBs() {
    if (pendingBs > 0) {
      var bs = '';
      for (var i = 0; i < pendingBs; i++) bs += SEQ.bs;
      sendKey(bs);
    }
    pendingBs = 0;
    pendingDeletedStr = '';
    pendingBsTimer = null;
    // Safety net for Samsung word suggestions: Samsung may delete the old
    // word (triggering pendingBs) then silently insert the replacement
    // WITHOUT firing an 'input' event.  Check shortly after flush.
    setTimeout(function() {
      if (shadowInput.value !== prevValue) {
        shadowInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, 30);
  }

  function cancelPendingBs() {
    if (pendingBsTimer) { clearTimeout(pendingBsTimer); pendingBsTimer = null; }
    pendingBs = 0;
    pendingDeletedStr = '';
  }

  shadowInput.addEventListener('compositionstart', function() {
    isComposing = true;
  });
  shadowInput.addEventListener('compositionend', function() {
    isComposing = false;
    // Samsung word suggestions may change the value during compositionend
    // without firing a separate 'input' event.  The deletion half fires
    // (pendingBs accumulates) but the insertion half is silent — result:
    // word gets deleted but replacement never arrives.
    // Fix: check after a short delay if the value diverged from prevValue.
    setTimeout(function() {
      if (shadowInput.value !== prevValue) {
        shadowInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, 30);
  });

  // beforeinput: ONLY prevent for Enter and empty-field backspace/delete.
  // Everything else passes through to let Samsung IME work normally.
  shadowInput.addEventListener('beforeinput', function(e) {
    var it = e.inputType || '';
    if (it === 'insertLineBreak' || it === 'insertParagraph') {
      e.preventDefault();
      cancelPendingBs();
      isComposing = false;
      shadowInput.value = ''; prevValue = '';
      sendKey(SEQ.enter);
    } else if (it === 'deleteContentBackward' && shadowInput.value.length === 0) {
      e.preventDefault();
      sendKey(SEQ.bs);
    } else if (it === 'deleteContentForward' && shadowInput.value.length === 0) {
      e.preventDefault();
      sendKey('\\x1b[3~');
    }
    // All other events: DO NOT prevent — Samsung IME needs them
  });

  // ── Full-diff input handler ────────────────────────────────────────────
  // Uses common-prefix diff to handle insertions, deletions, AND
  // replacements (Samsung autocorrect).  Multi-char deletions are deferred
  // briefly (50 ms) so Samsung prediction cleanup (delete then re-insert
  // same text) can be optimised to only send the truly new characters.
  // Autocorrect replacements (different text) flush immediately.
  shadowInput.addEventListener('input', function() {
    var cur = shadowInput.value;
    if (cur === prevValue) return;

    // Full diff: find common prefix via charCode comparison
    var cp = 0;
    var minLen = Math.min(prevValue.length, cur.length);
    while (cp < minLen && prevValue.charCodeAt(cp) === cur.charCodeAt(cp)) cp++;

    var deleted  = prevValue.slice(cp);
    var inserted = cur.slice(cp);

    // ── Pure deletion ────────────────────────────────────────────────
    if (inserted.length === 0 && deleted.length > 0) {
      pendingDeletedStr = deleted + pendingDeletedStr;
      pendingBs += deleted.length;
      if (pendingBsTimer) clearTimeout(pendingBsTimer);
      pendingBsTimer = setTimeout(flushPendingBs, 50);
      prevValue = cur;
      return;
    }

    // ── Insertion or replacement ─────────────────────────────────────
    var payload = '';

    if (pendingBs > 0) {
      if (pendingBs >= 3 && inserted.length >= pendingDeletedStr.length
          && inserted.slice(0, pendingDeletedStr.length) === pendingDeletedStr) {
        // Samsung prediction: reinserted text starts with deleted text.
        // Cancel deferred backspaces, send only the truly new characters.
        var trulyNew = inserted.slice(pendingDeletedStr.length);
        cancelPendingBs();
        for (var i = 0; i < deleted.length; i++) payload += SEQ.bs;
        payload += trulyNew;
      } else {
        // Autocorrect or real editing: combine pending + current diff
        var totalBs = pendingBs + deleted.length;
        if (pendingBsTimer) { clearTimeout(pendingBsTimer); pendingBsTimer = null; }
        pendingBs = 0; pendingDeletedStr = '';
        for (var i = 0; i < totalBs; i++) payload += SEQ.bs;
        payload += inserted;
      }
    } else {
      // No pending backspaces: apply full diff directly
      for (var i = 0; i < deleted.length; i++) payload += SEQ.bs;
      payload += inserted;
    }

    if (payload) sendKey(payload);
    prevValue = cur;

    // Clear field periodically to prevent Samsung buffer overflow.
    // Don't clear on space — autocorrect needs word context.
    if (cur.length > 60) {
      shadowInput.value = ''; prevValue = ''; cancelPendingBs();
    }
  });

  /* ── Resize ────────────────────────────────────────── */
  function reportSize() {
    sendToRN({ type: 'resize', cols: term.cols, rows: term.rows });
  }
  new ResizeObserver(function() { fitAddon.fit(); reportSize(); })
    .observe(document.getElementById('terminal'));

  /* ── Pinch-to-Zoom (does NOT block native scroll) ──── */
  var MIN_FONT = 8, MAX_FONT = 28, baseFontSize = 14;
  var pinchStartDist = 0, pinchStartFont = 14, isPinching = false;

  function pinchDist(e) {
    var t = e.touches;
    var dx = t[1].clientX - t[0].clientX;
    var dy = t[1].clientY - t[0].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // touchstart is PASSIVE — never blocks native scroll
  document.getElementById('terminal').addEventListener('touchstart', function(e) {
    if (e.touches.length === 2) {
      isPinching = true;
      pinchStartDist = pinchDist(e);
      pinchStartFont = term.options.fontSize || baseFontSize;
    }
  }, { passive: true });

  // Only touchmove is non-passive, and ONLY prevents default for 2-finger pinch
  document.getElementById('terminal').addEventListener('touchmove', function(e) {
    if (!isPinching || e.touches.length !== 2) return;
    e.preventDefault();
    var scale = pinchDist(e) / pinchStartDist;
    var newSize = Math.round(pinchStartFont * scale);
    newSize = Math.max(MIN_FONT, Math.min(MAX_FONT, newSize));
    if (newSize !== term.options.fontSize) {
      term.options.fontSize = newSize;
      fitAddon.fit();
      reportSize();
    }
  }, { passive: false });

  document.getElementById('terminal').addEventListener('touchend', function(e) {
    if (isPinching && e.touches.length < 2) {
      isPinching = false;
      baseFontSize = term.options.fontSize || baseFontSize;
    }
  }, { passive: true });

  // Track scroll position for sticky-scroll via the xterm viewport
  // Only update when user is actively touching (same gate as term.onScroll)
  var vp = document.querySelector('.xterm-viewport');
  if (vp) {
    vp.addEventListener('scroll', function() {
      if (userIsTouching) userScrolledUp = !isAtBottom();
    }, { passive: true });
  }

  // Scroll acceleration removed — xterm.js native scrollSensitivity (2) and
  // fastScrollSensitivity (8) handle momentum scrolling.  The custom multiplier
  // (up to 16×) was additive and caused the viewport to shoot to the top
  // on fast swipes.

  var termEl = document.getElementById('terminal');

  /* ── Two-tap row-range selection ───────────────────────────────────────── */
  var selMode = false;
  var tapStep = 0;      // 0=off  1=waiting start  2=waiting end
  var selRow1 = -1;     // absolute buffer row – start
  var selRow2 = -1;     // absolute buffer row – end
  var tapX0 = 0, tapY0 = 0, tapT0 = 0;

  // Thin line markers inside #terminal-container (position:relative child)
  function mkMarker(cls) {
    var d = document.createElement('div');
    d.className = 'row-marker ' + cls;
    document.getElementById('terminal-container').appendChild(d);
    return d;
  }
  var mkrS = mkMarker('row-marker-s');  // green – start row
  var mkrE = mkMarker('row-marker-e');  // blue  – end   row

  function getRowFromY(clientY) {
    var r  = document.getElementById('terminal').getBoundingClientRect();
    var ch = r.height / term.rows;
    var vr = Math.floor((clientY - r.top) / ch);
    return Math.max(0, Math.min(term.buffer.active.length - 1,
      vr + term.buffer.active.viewportY));
  }

  function placeMarker(m, bufRow) {
    var r  = document.getElementById('terminal').getBoundingClientRect();
    var ch = r.height / term.rows;
    var vr = bufRow - term.buffer.active.viewportY;
    if (vr < 0 || vr >= term.rows) { m.style.display = 'none'; return; }
    m.style.display = 'block';
    m.style.top = Math.round((vr + 1) * ch - 1) + 'px';
  }

  function refreshMarkers() {
    if (selRow1 >= 0) placeMarker(mkrS, selRow1);
    if (selRow2 >= 0) placeMarker(mkrE, selRow2);
  }

  function extractRange(r1, r2) {
    var from = Math.min(r1, r2), to = Math.max(r1, r2);
    var lines = [];
    for (var i = from; i <= to; i++) {
      var ln = term.buffer.active.getLine(i);
      if (ln) lines.push(ln.translateToString(true));
    }
    return lines.join('\\n').trimEnd();
  }

  function applyRangeSelect() {
    var from = Math.min(selRow1, selRow2), to = Math.max(selRow1, selRow2);
    term.select(0, from, (to - from + 1) * term.cols);
    var text = extractRange(from, to);
    sendToRN({ type: 'sel_update', text: text });
  }

  // (scroll listener for markers is combined with sticky-scroll handler above)

  // Tap = touchstart → touchend with little movement and short duration
  document.getElementById('terminal').addEventListener('touchstart', function(e) {
    if (!selMode) return;
    var t = e.touches[0];
    tapX0 = t.clientX; tapY0 = t.clientY; tapT0 = Date.now();
  }, { passive: true });

  document.getElementById('terminal').addEventListener('touchend', function(e) {
    if (!selMode) return;
    var t = e.changedTouches[0];
    if (Math.abs(t.clientX - tapX0) > 15 || Math.abs(t.clientY - tapY0) > 15) return;
    if (Date.now() - tapT0 > 600) return;   // long-press, ignore
    var row = getRowFromY(tapY0);
    if (tapStep === 1) {
      selRow1 = row; selRow2 = -1;
      placeMarker(mkrS, row);
      mkrE.style.display = 'none';
      term.clearSelection();
      tapStep = 2;
      sendToRN({ type: 'tap_step', step: 2 });
    } else if (tapStep === 2) {
      selRow2 = row;
      placeMarker(mkrE, row);
      applyRangeSelect();
      tapStep = 0;
    }
  }, { passive: true });

  /* ── Tap-to-copy paths & URLs ─────────────────────────────────────────── */
  var pathTapX0 = 0, pathTapY0 = 0, pathTapT0 = 0;
  var pathRegex = /((?:https?:\\/\\/[^\\s]+)|(?:~\\/[^\\s:,;'"\\)\\]]+)|(?:\\/(?:Users|home|tmp|etc|var|opt|usr|mnt)[^\\s:,;'"\\)\\]]+)|(?:(?:\\.\\/|\\.\\.\\/)[^\\s:,;'"\\)\\]]+)|(?:(?:[a-zA-Z0-9_-]+\\/){2,}[a-zA-Z0-9_.-]+))/;

  termEl.addEventListener('touchstart', function(e) {
    if (selMode || isPinching || e.touches.length !== 1) return;
    var t = e.touches[0];
    pathTapX0 = t.clientX; pathTapY0 = t.clientY; pathTapT0 = Date.now();
  }, { passive: true });

  termEl.addEventListener('touchend', function(e) {
    if (selMode || isPinching) return;
    var t = e.changedTouches[0];
    if (!t) return;
    if (Math.abs(t.clientX - pathTapX0) > 15 || Math.abs(t.clientY - pathTapY0) > 15) return;
    if (Date.now() - pathTapT0 > 600) return;
    var row = getRowFromY(pathTapY0);
    var line = term.buffer.active.getLine(row);
    if (!line) return;
    var text = line.translateToString(true);
    var m = text.match(pathRegex);
    if (m && m[1]) {
      sendToRN({ type: 'path_tapped', data: m[1] });
    }
  }, { passive: true });

  /* ── SQL detection (runs on xterm.js clean rendered text) ─────────────── */
  var SQL_PLAIN_RE = /((?:(?:^|\\n)\\s*SELECT|INSERT\\s+INTO|UPDATE\\s+\\S+(?:\\s+\\w+)?\\s+SET|DELETE\\s+FROM|CREATE\\s+(?:TABLE|OR\\s+REPLACE\\s+VIEW|INDEX|VIEW|DATABASE|SCHEMA|POLICY)|DROP\\s+(?:TABLE|INDEX|VIEW|DATABASE)|ALTER\\s+TABLE)\\b[\\s\\S]*?(?:;|(?=\\n\\s*\\n)))/gim;
  var SQL_BLOCK_RE = /\`\`\`(?:sql|postgresql|postgres|pgsql|mysql|sqlite|plpgsql)[^\\n]*\\n([\\s\\S]*?)\`\`\`/gi;
  var seenSqlHashes = new Set();
  function sqlHash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  var lastScanLine = 0;
  function getBufferText() {
    var buf = term.buffer.active;
    var parts = [];
    // No overlap — scan only new lines. The 900ms debounce ensures complete
    // statements are in the buffer. Overlap caused re-detection of deleted SQL.
    var start = lastScanLine;
    for (var i = start; i < buf.length; i++) {
      var ln = buf.getLine(i);
      if (!ln) continue;
      var txt = ln.translateToString(true);
      // Wrapped lines are continuations of the previous line — join without \\n.
      // Without this, identifiers split across rows (e.g. "pod_autom_\\nshops")
      // produce broken SQL that fails with syntax errors on Supabase.
      if (ln.isWrapped && parts.length > 0) {
        parts[parts.length - 1] += txt;
      } else {
        parts.push(txt);
      }
    }
    lastScanLine = buf.length;
    return parts.join('\\n');
  }
  function runSqlScan() {
    var text = getBufferText();
    var found = [];
    SQL_BLOCK_RE.lastIndex = 0;
    var m;
    while ((m = SQL_BLOCK_RE.exec(text)) !== null) {
      var s = m[1].trim();
      if (!s) continue;
      var h = sqlHash(s);
      if (!seenSqlHashes.has(h)) { if (seenSqlHashes.size > 2000) seenSqlHashes.clear(); seenSqlHashes.add(h); found.push(s); }
    }
    // Collect individual SQL matches with positions
    SQL_PLAIN_RE.lastIndex = 0;
    var matches = [];
    while ((m = SQL_PLAIN_RE.exec(text)) !== null) {
      if (m[1].trim()) matches.push({ s: m.index, e: m.index + m[0].length });
    }
    // Merge consecutive SQL matches that belong to the same script.
    // If the gap between two matches contains only whitespace and SQL comments (-- ...),
    // they are part of the same migration script → merge into one block.
    var i = 0;
    while (i < matches.length) {
      var gs = matches[i].s, ge = matches[i].e, j = i + 1;
      while (j < matches.length) {
        var gap = text.substring(ge, matches[j].s).replace(/--[^\\n]*/g, '').trim();
        if (gap.length < 30) { ge = matches[j].e; j++; } else break;
      }
      var block;
      if (j - i >= 2) {
        // Multi-statement script — also capture leading SQL comments above
        var before = text.substring(Math.max(0, gs - 500), gs);
        var cm = before.match(/((?:--[^\\n]*\\n\\s*)+)$/);
        block = (cm ? cm[1] : '') + text.substring(gs, ge);
      } else {
        block = text.substring(gs, ge);
      }
      block = block.trim();
      if (block && (block.length > 30 || block.indexOf('\\n') !== -1)) {
        var h = sqlHash(block);
        if (!seenSqlHashes.has(h)) { if (seenSqlHashes.size > 2000) seenSqlHashes.clear(); seenSqlHashes.add(h); found.push(block); }
      }
      i = j;
    }
    if (found.length > 0) sendToRN({ type: 'sql_detected', sqls: found });
  }
  var sqlTimer = null;
  function scheduleSqlScan() {
    if (sqlTimer) clearTimeout(sqlTimer);
    sqlTimer = setTimeout(function() { sqlTimer = null; runSqlScan(); }, 900);
  }

  /* ── Sticky scroll ─────────────────────────────────── */
  // Track whether the user is "pinned" to the bottom.
  // If they scroll up, we stop auto-scrolling. If they scroll
  // back to the bottom, we resume auto-scrolling.
  var userScrolledUp = false;
  var userIsTouching = false; // true while finger is on screen

  // Check if viewport is at the bottom of the buffer
  function isAtBottom() {
    var buf = term.buffer.active;
    return buf.viewportY >= buf.baseY;
  }

  // Only track scroll direction changes caused by USER touch interaction.
  // Internal scrolls (from term.write, term.scrollToBottom, momentum) must not
  // flip userScrolledUp — otherwise the terminal snaps to bottom mid-read.
  term.onScroll(function() {
    if (userIsTouching) {
      userScrolledUp = !isAtBottom();
    }
    if (selMode) refreshMarkers();
  });

  // Track touch lifecycle — userIsTouching gates the onScroll handler above
  document.getElementById('terminal').addEventListener('touchstart', function() {
    userIsTouching = true;
  }, { passive: true });
  document.getElementById('terminal').addEventListener('touchend', function() {
    // Small delay so the final inertia scroll events still count as user-initiated
    setTimeout(function() { userIsTouching = false; }, 300);
  }, { passive: true });

  /* ── Messages from RN ──────────────────────────────── */
  function handleMsg(data) {
    try {
      var msg = typeof data === 'string' ? JSON.parse(data) : data;
      if      (msg.type === 'output') {
        term.write(msg.data, function() {
          // Live-check: only auto-scroll if user hasn't scrolled up.
          // Previous snapshot approach (wasAtBottom captured before write)
          // caused stale closures to yank viewport to bottom when the user
          // scrolled up while queued writes were pending.
          if (!userScrolledUp) {
            term.scrollToBottom();
          }
          scheduleSqlScan();
        });
      }
      else if (msg.type === 'clear')  term.clear();
      else if (msg.type === 'focus')  {
        fitAddon.fit(); reportSize();
        // Sync prevValue with the actual shadow input content to prevent
        // phantom deletions when the diff sees a stale prevValue.
        prevValue = shadowInput.value;
        cancelPendingBs();
        if (!selMode && !userScrolledUp) focusShadow();
      }
      else if (msg.type === 'blur')   {
        // Release keyboard focus so keystrokes stop going to this tab
        shadowInput.blur();
        // Reset input state to prevent stale diffs when re-focused
        shadowInput.value = ''; prevValue = '';
        cancelPendingBs();
      }
      else if (msg.type === 'get_all') {
        var buf = term.buffer.active;
        var lines = [];
        for (var i = 0; i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true));
        sendToRN({ type: 'all_text', text: lines.join('\\n').trimEnd() });
      }
      else if (msg.type === 'get_cursor_line') {
        var buf = term.buffer.active;
        var cy = buf.cursorY + buf.viewportY;
        var ln = buf.getLine(cy);
        sendToRN({ type: 'cursor_line', text: ln ? ln.translateToString(true) : '' });
      }
      else if (msg.type === 'clear_selection') { term.clearSelection(); }
      else if (msg.type === 'enter_select_mode') {
        selMode = true; tapStep = 1; selRow1 = -1; selRow2 = -1;
        mkrS.style.display = 'none'; mkrE.style.display = 'none';
        term.clearSelection();
      }
      else if (msg.type === 'exit_select_mode') {
        selMode = false; tapStep = 0; selRow1 = -1; selRow2 = -1;
        mkrS.style.display = 'none'; mkrE.style.display = 'none';
        term.clearSelection();
      }
      else if (msg.type === 'copy_selection') {
        var txt = term.getSelection() || extractRange(Math.min(selRow1, selRow2), Math.max(selRow1, selRow2));
        sendToRN({ type: 'range_text', text: txt });
      }
      else if (msg.type === 'scroll_to_bottom') {
        term.scrollToBottom();
        userScrolledUp = false;
      }
      else if (msg.type === 'get_last_lines') {
        var cnt = msg.count || 20;
        var buf = term.buffer.active;
        var total = buf.length;
        var from = Math.max(0, total - cnt);
        var ls = [];
        for (var i = from; i < total; i++) {
          var ln2 = buf.getLine(i);
          if (ln2) ls.push(ln2.translateToString(true));
        }
        sendToRN({ type: 'last_lines', lines: ls });
      }
      else if (msg.type === 'inject_text' && msg.data) {
        var shadow = document.getElementById('shadow-input');
        shadow.value = msg.data;
        prevValue = '';
        shadow.dispatchEvent(new Event('input', { bubbles: true }));
      }
      else if (msg.type === 'setExternalKeyboardMode') {
        shadowInput.setAttribute('inputmode', msg.enabled ? 'none' : 'text');
        if (msg.enabled) {
          shadowInput.blur();
          setTimeout(function() { shadowInput.focus({ preventScroll: true }); }, 50);
        }
      }
    } catch(e) {}
  }
  /* Block native long-press context menu (Android "Paste" popup) */
  document.addEventListener('contextmenu', function(e) { e.preventDefault(); }, { passive: false });

  window.addEventListener('message',   function(e) { handleMsg(e.data); });
  document.addEventListener('message', function(e) { handleMsg(e.data); });

  fitAddon.fit();
  reportSize();
  sendToRN({ type: 'ready', cols: term.cols, rows: term.rows });
})();
</script>
</body>
</html>`;

export { TERMINAL_HTML };
