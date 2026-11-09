import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/season2/web/bridge.js', import.meta.url), 'utf8');
function block(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'production bridge section exists');
  return source.slice(start, end);
}
function clock() {
  let sequence = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay) { timers.set(++sequence, { fn, delay }); return sequence; },
    clearTimeout(id) { timers.delete(id); },
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(({ fn }) => fn()); },
    get pending() { return timers.size; },
    get delays() { return [...timers.values()].map(timer => timer.delay); },
  };
}
// Monospace cell that follows the font like the real page: advance 0.6em,
// row height 1.6em + 2px. Default font 13px; the bridge may set host.style.fontSize.
const fontOf = (el) => parseFloat((el.style && el.style.fontSize) || '13px');
// A 402px card (Fold cover after the compact layout) → 382px text → 12.7px font,
// 50 cols; 480px text height → 21 rows of 22.32px.
function sizing({ width = 402, height = 500 } = {}) {
  const time = clock();
  const resized = [];
  const host = { clientWidth: width, clientHeight: height, style: {} };
  const term = { cols: 50, rows: 21, resize(cols, rows) { resized.push([cols, rows]); this.cols = cols; this.rows = rows; } };
  const state = { host, term };
  const context = vm.createContext({
    terms: { a: state }, ...time,
    measureCell: (el) => ({ w: 0.6 * fontOf(el), h: 1.6 * fontOf(el) + 2 }),
    getComputedStyle: (el) => ({ paddingLeft: '10', paddingRight: '10', paddingTop: '10', paddingBottom: '10', fontSize: fontOf(el) + 'px' }),
    invalidateRowCache() {}, renderTerm() {},
  });
  vm.runInContext(block('  function measureFit(t)', '  function fitSoon(cardId)'), context);
  return { context, host, term, state, resized, time };
}

test('OpenCode is recognised by its process name on Mac, Linux and Windows', () => {
  const context = vm.createContext({});
  vm.runInContext(block('  var MOUSE_TUIS', '  function forceMouseOn(t)'), context);
  for (const name of ['opencode', '/Users/x/.opencode/bin/opencode', 'opencode.exe', 'OpenCode.EXE',
    'C:\\Users\\k\\AppData\\Local\\opencode\\opencode.exe']) {
    assert.equal(context.isMouseTui(name), true, name);
  }
  for (const name of ['claude', 'pwsh.exe', 'node.exe', '', undefined]) assert.equal(context.isMouseTui(name), false, String(name));
});
test('every phone-sized card gets exactly 50 columns; the font follows the width', () => {
  for (const [width, font] of [[402, 12.7], [430, 13.6], [520, 16.6]]) {
    const t = sizing({ width });
    const fit = t.context.measureFit(t.state);
    assert.equal(fit.cols, 50, `${width}px card → 50 cols`);
    assert.equal(fontOf(t.host), font, `${width}px card → ${font}px font`);
  }
});
test('a wide card (split screen) keeps 50 columns; the font stops at 20px', () => {
  const t = sizing({ width: 800 });
  const fit = t.context.measureFit(t.state);
  assert.equal(fit.cols, 50);
  assert.equal(fontOf(t.host), 20);
});
test('unfolding or widening never changes the PTY width', () => {
  const t = sizing(); t.context.fitNow('a');
  for (const width of [430, 800, 520, 402]) { t.host.clientWidth = width; t.context.fitNow('a'); t.time.tick(); }
  assert.ok(t.resized.every(([cols]) => cols === 50), JSON.stringify(t.resized));
});
test('very narrow cards fall back to fewer columns instead of unreadable text', () => {
  const t = sizing({ width: 302 });
  const fit = t.context.measureFit(t.state);
  assert.equal(fontOf(t.host), 10, 'font never below 10px');
  assert.equal(fit.cols, 47);
});
test('opening and closing the keyboard never shrinks the PTY rows (row ratchet)', () => {
  const t = sizing();
  assert.equal(t.context.fitNow('a'), true);
  assert.equal(t.term.rows, 21);
  t.host.clientHeight = 180;                       // keyboard opens
  t.context.fitNow('a'); t.time.tick();
  assert.deepEqual(t.resized, [],
    'rows stay at 21: with fewer rows than Claude\'s live region, Ink leaves a copy of every frame (E2E 1 → 14 banners)');
  t.host.clientHeight = 500;                       // keyboard closes
  t.context.fitNow('a'); t.time.tick();
  assert.deepEqual(t.resized, [], 'no SIGWINCH for a keyboard round-trip at all');
  t.host.clientWidth = 302;                        // a real column change resets the ratchet
  t.context.fitNow('a'); t.time.tick();
  assert.deepEqual(t.resized.at(-1), [47, 26]);
});
test('continuous divider dragging produces only the final resize', () => {
  const t = sizing(); t.context.fitNow('a');
  for (const height of [560, 620, 680, 740]) { t.host.clientHeight = height; t.context.fitNow('a'); }
  assert.equal(t.time.pending, 1);
  assert.equal(t.resized.length, 0);
  t.time.tick();
  assert.deepEqual(t.resized, [[50, 32]]);
});
// VIRTUELLE HÖHE: Claudes Bestätigungs-Boxen sind bei 50 Spalten oft höher als
// die Karte. Ist die PTY niedriger als die Box, bleiben Box-Reste im Verlauf.
function virtualSizing(opts) {
  const t = sizing(opts);
  t.state.virt = true;
  t.term.buffer = { active: { type: 'normal' } };
  return t;
}
test('virtual height: the PTY gets 200 rows while the card shows ~21', () => {
  const t = virtualSizing(); t.context.fitNow('a');
  assert.deepEqual([t.term.cols, t.term.rows], [50, 200]);
  t.host.clientHeight = 260; t.context.fitNow('a'); t.time.tick();   // keyboard opens
  t.host.clientHeight = 500; t.context.fitNow('a'); t.time.tick();   // and closes
  assert.deepEqual(t.resized, [[50, 200]], 'keyboard never resizes the PTY');
});
test('full-screen programs (alternate screen) get the real card height, and 200 again afterwards', () => {
  const t = virtualSizing(); t.context.fitNow('a');
  t.term.buffer.active.type = 'alternate';                          // vim / OpenCode start
  t.context.fitNow('a'); t.time.tick();
  assert.deepEqual([t.term.cols, t.term.rows], [50, 21], 'ratchet must not keep 200 for vim');
  t.term.buffer.active.type = 'normal';                             // vim quits
  t.context.fitNow('a'); t.time.tick();
  assert.deepEqual([t.term.cols, t.term.rows], [50, 200]);
});
test('mouse TUIs (OpenCode under Windows: no alternate screen) also get the real height', () => {
  const t = virtualSizing(); t.state.forceMouse = true; t.context.fitNow('a');
  assert.deepEqual([t.term.cols, t.term.rows], [50, 21]);
});
test('Windows: vim/less are only known by process name (ConPTY hides the alternate screen) → real height', () => {
  const t = virtualSizing(); t.state.cardId = 'a';
  t.context.byCard = { a: 'sid-a' }; t.context.procBySession = { 'sid-a': 'pwsh.exe' };
  t.context.fitNow('a');
  assert.equal(t.term.rows, 200, 'PowerShell prompt: virtual height');
  t.context.procBySession['sid-a'] = 'C:\\Program Files\\Vim\\vim91\\vim.exe';
  t.context.fitNow('a'); t.time.tick();
  assert.equal(t.term.rows, 21, 'vim.exe: real card height');
  t.context.procBySession['sid-a'] = 'pwsh.exe';
  t.context.fitNow('a'); t.time.tick();
  assert.equal(t.term.rows, 200, 'back at the prompt: virtual height again');
});
test('without xterm change tracking the virtual height stays off (old behaviour)', () => {
  const t = sizing(); t.term.buffer = { active: { type: 'normal' } }; t.context.fitNow('a');
  assert.equal(t.term.rows, 21);
});
test('a cancelled resize does not repaint or resize the terminal', () => {
  const t = sizing(); t.context.fitNow('a');
  t.host.clientHeight = 200; t.context.fitNow('a');
  t.host.clientHeight = 500; t.context.fitNow('a'); t.time.tick();
  assert.deepEqual(t.resized, []);
});
test('hidden hosts and sessions closed during settling cannot receive a stale resize', () => {
  const t = sizing(); t.context.fitNow('a');
  t.host.clientHeight = 0;
  assert.equal(t.context.fitNow('a'), false);
  t.host.clientHeight = 140; t.context.fitNow('a');
  delete t.context.terms.a; t.time.tick();
  assert.deepEqual(t.resized, []);
});
test('small windows can fit fewer than five terminal rows', () => {
  const t = sizing(); t.host.clientHeight = 80;
  t.context.fitNow('a');
  assert.equal(t.term.rows, 2);
});
test('a settled row change reaches the PTY promptly and duplicate dimensions are suppressed', () => {
  const time = clock();
  const sent = [];
  const context = vm.createContext({
    ...time, byCard: { a: 'sid-a' }, terms: { a: { term: { cols: 80, rows: 8 } } },
    post: (type, payload) => sent.push({ type, payload }),
  });
  vm.runInContext(block('  var resizeTimers = {}, lastDims = {};', '  /** Vorschau für Übersicht'), context);
  context.lastDims['sid-a'] = '80x24';
  context.queueResize('a', 80, 8);
  assert.deepEqual(time.delays, [16], 'no second 350ms delay after the stable resize');
  time.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'terminal:resize');
  assert.equal(sent[0].payload.rows, 8);
  context.queueResize('a', 80, 8); time.tick();
  assert.equal(sent.length, 1);
});

function drafts() {
  let active = 'a';
  const sent = [];
  const listeners = {};
  const input = {
    value: '', selectionStart: 0, selectionEnd: 0,
    addEventListener(type, fn) { listeners[type] = fn; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  };
  const window = {
    dockTargetId: () => active,
    TMS_DATA: { sessions: [{ id: 'a' }, { id: 'b' }] },
    autoGrowInput() {}, syncDockTerminal() {}, handleTermKey() {}, sendCtrlC() {},
    __tmsInput(id, data) { sent.push({ id, data }); },
  };
  const context = vm.createContext({ document: { getElementById: () => input }, window, byCard: { a: 'sid-a', b: 'sid-b' } });
  vm.runInContext(block("  var dockInput = document.getElementById('dockInput');", '  // Die Seite stimmt NIE selbst zu.'), context);
  return {
    input, window, sent,
    type(value) { input.value = value; input.selectionStart = input.selectionEnd = value.length; listeners.input(); },
    switch(id) { active = id; window.syncDockTerminal(); },
  };
}
test('switching sessions restores the draft and sent baseline without repeating any PTY input', () => {
  const t = drafts();
  t.type('alpha'); t.input.setSelectionRange(2, 4);
  t.switch('b'); assert.equal(t.input.value, '');
  t.type('beta'); t.switch('a');
  assert.equal(t.input.value, 'alpha');
  assert.equal(t.input.selectionStart, 2);
  assert.equal(t.input.selectionEnd, 4);
  assert.deepEqual(t.sent, [{ id: 'a', data: 'alpha' }, { id: 'b', data: 'beta' }]);
  t.type('alphax');
  assert.deepEqual(t.sent.at(-1), { id: 'a', data: 'x' });
  t.switch('b'); assert.equal(t.input.value, 'beta');
});
test('sending clears only that session and sends Enter once', () => {
  const t = drafts(); t.type('alpha'); t.switch('b'); t.type('beta');
  t.window.sendTerminalCommand('b', 'beta');
  assert.equal(t.input.value, '');
  assert.deepEqual(t.sent.at(-1), { id: 'b', data: '\r' });
  t.switch('a'); assert.equal(t.input.value, 'alpha');
  t.switch('b'); assert.equal(t.input.value, '');
});
test('Ctrl C on another session does not erase the active input', () => {
  const t = drafts(); t.type('alpha'); t.switch('b'); t.type('beta');
  t.window.handleTermKey('ctrlc', 'a');
  assert.equal(t.input.value, 'beta');
  t.switch('a'); assert.equal(t.input.value, '');
});
test('IME word replacement still sends only the correction after restoring a draft', () => {
  const t = drafts(); t.type('helo'); t.switch('b'); t.switch('a'); t.type('hello');
  assert.deepEqual(t.sent.at(-1), { id: 'a', data: '\x7flo' });
});

function viewport() {
  const source = readFileSync(new URL('../../mockups/season2/liquid-deck/compact-terminal.js', import.meta.url), 'utf8');
  const classes = new Set();
  const properties = new Map();
  const events = [];
  const counters = { grow: 0 };
  const label = { style: {} };
  const body = { classList: {
    contains: name => classes.has(name),
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
  } };
  const modal = () => ({ open: false, close() { this.open = false; } });
  const context = vm.createContext({
    frame: 0, reading: false, signature: '', fontSize: 15, currentScreen: 'terminals',
    // Phone width: from 700 px on the Bund desk view uses the compact layout on purpose.
    window: { innerHeight: 800, innerWidth: 412, visualViewport: { height: 800, offsetTop: 0, scale: 1 }, dispatchEvent: e => events.push(e.type) },
    root: { style: { setProperty: (key, value) => properties.set(key, value) } },
    body, dock: { offsetHeight: 54 }, keys: { offsetHeight: 45, hidden: true },
    input: {}, sessions: modal(), settings: modal(), header: { querySelector: () => label },
    state: { dockPage: 'term', dockRecording: false, keysPanelOpen: false },
    TMS_DATA: { sessions: [] }, STATUS_LABELS: {}, target: () => null,
    autoGrowInput: () => counters.grow++, closeAllListRails() {},
    closeIsland() {}, toggleOverview() {}, Event,
  });
  vm.runInContext(source.slice(source.indexOf('  function sync() {'), source.indexOf('  function schedule()')), context);
  return { context, classes, properties, events, counters };
}
test('visible viewport changes activate compact/tight layouts and use the measured accessory heights', () => {
  const t = viewport();
  t.context.window.visualViewport.height = 380;
  t.context.sync();
  assert.ok(t.classes.has('compact-terminal'));
  assert.ok(!t.classes.has('compact-tight'));
  assert.equal(t.properties.get('--compact-vp-h'), '380px');
  t.context.keys.hidden = false; t.context.state.keysPanelOpen = true;
  t.context.dock.offsetHeight = 76;
  t.context.window.visualViewport.height = 220;
  t.context.sync();
  assert.ok(t.classes.has('compact-tight'));
  assert.equal(t.properties.get('--compact-dock-h'), '76px');
  assert.equal(t.properties.get('--compact-keys-h'), '45px');
  assert.equal(t.counters.grow, 2, 'recalculate the input when its line cap changes');
  assert.equal(t.context.fontSize, 15, 'a smaller window never reduces the text size');
});
test('Android adjustResize is not counted twice and returning to a full window restores the regular layout', () => {
  const t = viewport();
  t.context.window.innerHeight = t.context.window.visualViewport.height = 260;
  t.context.sync();
  assert.equal(t.properties.get('--compact-vp-h'), '260px');
  t.context.settings.open = true;
  t.context.window.innerHeight = t.context.window.visualViewport.height = 800;
  t.context.sync();
  assert.ok(!t.classes.has('compact-terminal'));
  assert.ok(!t.classes.has('compact-tight'));
  assert.equal(t.context.settings.open, false);
  assert.equal(t.counters.grow, 2, 'restore the input height after leaving compact mode');
});
test('reading focus reclaims the dock but cannot conceal an active recording', () => {
  const t = viewport(); t.context.window.visualViewport.height = 380;
  t.context.reading = true; t.context.sync();
  assert.ok(t.classes.has('compact-reading'));
  assert.equal(t.properties.get('--compact-dock-h'), '0px');
  t.context.state.dockRecording = true; t.context.sync();
  assert.ok(!t.classes.has('compact-reading'));
  assert.equal(t.properties.get('--compact-dock-h'), '54px');
});
test('pinch zoom, other screens and the lock screen do not enable a terminal layout', () => {
  const t = viewport();
  t.context.window.visualViewport.height = 220;
  t.context.window.visualViewport.scale = 2;
  t.context.sync();
  assert.ok(!t.classes.has('compact-terminal'));
  t.context.window.visualViewport.scale = 1;
  t.context.currentScreen = 'settings'; t.context.sync();
  assert.ok(!t.classes.has('compact-terminal'));
  t.context.currentScreen = 'terminals'; t.classes.add('is-locked'); t.context.sync();
  assert.ok(!t.classes.has('compact-terminal'));
});

test('Bund: unfolded (>= 700 px) uses the compact terminal at full height — bund.js adds the sidebar', () => {
  const t = viewport();
  t.context.window.innerWidth = 875;
  t.context.window.innerHeight = t.context.window.visualViewport.height = 970;
  t.context.sync();
  assert.ok(t.classes.has('compact-terminal'));
});
