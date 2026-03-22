export const TERMINAL_HTML = `<!DOCTYPE html>
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
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
</head>
<body>

<div id="terminal-container">
  <div id="terminal"></div>
  <input id="shadow-input" type="text"
    autocomplete="off" autocorrect="off"
    autocapitalize="none" spellcheck="false" inputmode="text"/>
</div>

<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-canvas@0.7.0/lib/addon-canvas.min.js"></script>
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
  });
  var fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
  term.open(document.getElementById('terminal'));

  // Use Canvas renderer instead of DOM — dramatically faster scrolling.
  // Canvas renders to a single <canvas> element instead of creating
  // hundreds of DOM nodes per visible row.
  try {
    var canvasAddon = new window.CanvasAddon.CanvasAddon();
    term.loadAddon(canvasAddon);
  } catch(e) {
    // Fallback to DOM renderer if canvas not supported
  }

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
  document.getElementById('terminal').addEventListener('click', function(e) {
    if (!selMode) { e.preventDefault(); focusShadow(); }
  });

  /* ── Shadow input (soft keyboard) ─────────────────── */
  var shadowInput = document.getElementById('shadow-input');
  var prevValue   = '';
  var isComposing = false;

  function focusShadow() {
    // Use preventScroll to avoid Android WebView haptic feedback on focus
    shadowInput.focus({ preventScroll: true });
    shadowInput.setSelectionRange(shadowInput.value.length, shadowInput.value.length);
    // Auto-scroll to bottom when keyboard opens
    term.scrollToBottom();
    userScrolledUp = false;
  }

  /* Physical keyboard (emulator / Bluetooth) */
  document.addEventListener('keydown', function(e) {
    if (isComposing) return;
    var s = physicalKey(e);
    if (s) { e.preventDefault(); sendKey(s); }
  });

  function physicalKey(e) {
    if (e.key === 'ArrowUp')    return SEQ.up;
    if (e.key === 'ArrowDown')  return SEQ.down;
    if (e.key === 'ArrowRight') return SEQ.right;
    if (e.key === 'ArrowLeft')  return SEQ.left;
    if (e.key === 'Enter')      return SEQ.enter;
    if (e.key === 'Backspace')  return SEQ.bs;
    if (e.key === 'Delete')     return '\\x1b[3~';
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

  shadowInput.addEventListener('compositionstart', function() { isComposing = true; });
  shadowInput.addEventListener('compositionend', function() {
    isComposing = false;
    setTimeout(function() {
      if (!isComposing) { shadowInput.value = ''; prevValue = ''; }
    }, 50);
  });

  // beforeinput fires EVEN when the field is empty — catches backspace
  // that the 'input' event misses on Android when value is ''.
  var deleteHandledByBeforeInput = false;
  shadowInput.addEventListener('beforeinput', function(e) {
    var it = e.inputType || '';
    if (it === 'deleteContentBackward') {
      e.preventDefault();
      sendKey(SEQ.bs);
      shadowInput.value = ''; prevValue = '';
      deleteHandledByBeforeInput = true;
    } else if (it === 'deleteContentForward') {
      e.preventDefault();
      sendKey('\\x1b[3~');
      shadowInput.value = ''; prevValue = '';
      deleteHandledByBeforeInput = true;
    } else {
      deleteHandledByBeforeInput = false;
    }
  });

  shadowInput.addEventListener('input', function(e) {
    // Skip if beforeinput already handled this delete
    if (deleteHandledByBeforeInput) { deleteHandledByBeforeInput = false; return; }

    var cur = shadowInput.value;
    var it = e.inputType || '';

    // Fallback deletion (in case beforeinput didn't fire)
    if (it.indexOf('delete') === 0 || cur.length < prevValue.length) {
      var del = Math.max(1, prevValue.length - cur.length);
      var bs = '';
      for (var i = 0; i < del; i++) bs += SEQ.bs;
      sendKey(bs);
      shadowInput.value = ''; prevValue = '';
      return;
    }

    // Non-composition: use e.data and clear immediately.
    // Clearing after every char prevents value accumulation that causes
    // Samsung keyboard to desync on the Fold 7 unfolded screen.
    if (!isComposing && e.data) {
      sendKey(e.data);
      shadowInput.value = ''; prevValue = '';
      return;
    }

    // Composition: diff-based (can't clear during composition —
    // keyboard needs the value for prediction/autocorrect)
    var added = cur.slice(prevValue.length);
    if (added === '\\n' || added === '\\r' || added === '\\r\\n') {
      sendKey(SEQ.enter); shadowInput.value = ''; prevValue = ''; return;
    }
    if (added) sendKey(added);
    prevValue = cur;
    // Safety net: clear if value grows too long during composition
    if (cur.length > 50) { shadowInput.value = ''; prevValue = ''; }
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
  var vp = document.querySelector('.xterm-viewport');
  if (vp) {
    vp.addEventListener('scroll', function() {
      userScrolledUp = !isAtBottom();
    }, { passive: true });
  }

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

  // Check if viewport is at the bottom of the buffer
  function isAtBottom() {
    var buf = term.buffer.active;
    return buf.viewportY >= buf.baseY;
  }

  // When the user scrolls, detect if they left the bottom
  term.onScroll(function() {
    userScrolledUp = !isAtBottom();
    if (selMode) refreshMarkers();
  });

  /* ── Messages from RN ──────────────────────────────── */
  function handleMsg(data) {
    try {
      var msg = typeof data === 'string' ? JSON.parse(data) : data;
      if      (msg.type === 'output') {
        // If user was at bottom, stay at bottom after write.
        // If user scrolled up, don't force-scroll.
        var wasAtBottom = !userScrolledUp;
        term.write(msg.data, function() {
          if (wasAtBottom) {
            term.scrollToBottom();
            userScrolledUp = false;
          }
          scheduleSqlScan();
        });
      }
      else if (msg.type === 'clear')  term.clear();
      else if (msg.type === 'focus')  { fitAddon.fit(); reportSize(); if (!selMode) focusShadow(); }
      else if (msg.type === 'get_all') {
        var buf = term.buffer.active;
        var lines = [];
        for (var i = 0; i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true));
        sendToRN({ type: 'all_text', text: lines.join('\\n').trimEnd() });
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
