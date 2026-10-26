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
function sizing() {
  const time = clock();
  const resized = [];
  const host = { clientWidth: 820, clientHeight: 500 };
  const term = { cols: 80, rows: 24, resize(cols, rows) { resized.push([cols, rows]); this.cols = cols; this.rows = rows; } };
  const state = { host, term };
  const context = vm.createContext({
    terms: { a: state }, ...time,
    measureCell: () => ({ w: 10, h: 20 }),
    getComputedStyle: () => ({ paddingLeft: '10', paddingRight: '10', paddingTop: '10', paddingBottom: '10' }),
    invalidateRowCache() {}, renderTerm() {},
  });
  vm.runInContext(block('  function measureFit(t)', '  function fitSoon(cardId)'), context);
  return { context, host, term, state, resized, time };
}
test('opening and closing the keyboard settles both PTY rows and columns to the real content box', () => {
  const t = sizing();
  assert.equal(t.context.fitNow('a'), true);
  assert.equal(t.term.rows, 24);
  t.host.clientHeight = 180;
  t.context.fitNow('a');
  assert.equal(t.term.rows, 24, 'no intermediate SIGWINCH during the keyboard animation');
  t.time.tick();
  assert.deepEqual(t.resized, [[80, 8]], 'rows shrink instead of retaining a cropped 24-row TUI');
  t.host.clientHeight = 500;
  t.context.fitNow('a'); t.time.tick();
  assert.deepEqual(t.resized.at(-1), [80, 24]);
  t.host.clientWidth = 420;
  t.context.fitNow('a'); t.time.tick();
  assert.deepEqual(t.resized.at(-1), [40, 24]);
});
test('continuous divider dragging produces only the final resize', () => {
  const t = sizing(); t.context.fitNow('a');
  for (const height of [460, 320, 280, 240]) { t.host.clientHeight = height; t.context.fitNow('a'); }
  assert.equal(t.time.pending, 1);
  assert.equal(t.resized.length, 0);
  t.time.tick();
  assert.deepEqual(t.resized, [[80, 11]]);
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
  assert.equal(t.term.rows, 3);
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
    window: { innerHeight: 800, innerWidth: 700, visualViewport: { height: 800, offsetTop: 0, scale: 1 }, dispatchEvent: e => events.push(e.type) },
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
