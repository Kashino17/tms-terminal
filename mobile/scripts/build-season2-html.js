#!/usr/bin/env node
/**
 * Builds the Season-2 app UI *from* the Liquid-Deck mockup.
 *
 * The mockup is the single source of truth for look, layout, animation and
 * gestures. This script takes its HTML verbatim and swaps only the demo layer:
 * the scripted simulator goes away, the card bodies become real xterm.js
 * terminals, and a bridge (src/season2/web/bridge.js) connects everything to
 * React Native — WebSocket, PTY, mic, clipboard.
 *
 *   npm run build:season2   ->  src/season2/web/liquidDeckHtml.ts
 */
const fs = require('fs');
const path = require('path');

const MOCKUP_DIR = '/Users/ayysir/Desktop/TMS Terminal/mockups/season2';
const OUT = path.resolve(__dirname, '../src/season2/web/liquidDeckHtml.ts');

let html = fs.readFileSync(path.join(MOCKUP_DIR, 'liquid-deck/index.html'), 'utf8');
const dataJs = fs.readFileSync(path.join(MOCKUP_DIR, 'shared/data.js'), 'utf8');
const bridgeJs = fs.readFileSync(path.resolve(__dirname, '../src/season2/web/bridge.js'), 'utf8');

/** Applies a required source patch and fails loudly if the mockup moved on. */
function patch(label, find, replace) {
  if (!html.includes(find)) throw new Error(`patch "${label}" no longer matches the mockup — update build-season2-html.js`);
  html = html.replace(find, replace);
}

// ── 1) The demo scripts: keep the world (servers, prayer, cloud, tools) but
//       drop the simulator, and start with zero terminals — real PTY sessions
//       are restored by the bridge once React Native has connected.
patch('data.js tag', '<script src="../shared/data.js" charset="utf-8"></script>', `<script>
${dataJs}
// Kein einziges Demo-Datum darf je zu sehen sein: alles, was React Native
// nachliefert, startet leer — sonst zeigt ein Sheet Platzhalter, bis (oder
// falls) die echten Daten eintreffen.
window.TMS_DATA.sessions = [];
window.TMS_DATA.files = [];
window.TMS_DATA.processes = [];
window.TMS_DATA.watchers = [];
window.TMS_DATA.ports = [];
window.TMS_DATA.snippets = [];
window.TMS_DATA.notes = [];
window.TMS_DATA.screenshots = [];
window.TMS_DATA.sql = { statements: [] };
window.TMS_DATA.cloudProjects = [];
window.TMS_DATA.cloudAccounts = { vercel: { connected: false, maskedKey: null }, render: { connected: false, maskedKey: null } };
window.TMS_DATA.manager.messages = [];
window.TMS_DATA.manager.artifacts = [];
window.TMS_DATA.manager.memory = [];
window.TMS_DATA.update = { current: '', latest: '', notes: '' };
// Die Gebetszeiten bleiben als Rückfall stehen: nextPrayer() läuft beim Start,
// bevor der echte Standort da ist, und die Insel würde sonst rechnen mit nichts.
// No simulator: every card's "sim" is a thin proxy onto its PTY, handed out by
// the bridge (see the cardState patches below), so the mockup's prompt/answer
// plumbing keeps working against a real terminal.
window.TMSSim = { createSession: function () { return { on: function () { return this; }, start: function () {}, reset: function () {}, respond: function () {} }; } };
window.__tmsSim = function () { return window.TMSSim.createSession(); };
window.__tmsInput = function () {};
</script>`);
html = html.replace(/\s*<script src="\.\.\/shared\/sim\.js" charset="utf-8"><\/script>/, '');

// ── 2) Served from a data: URL, so the cp1252 repair the dev server needed
//       would now corrupt correct strings.
patch('fixString', 'function fixString(str) {', 'function fixString(str) { return str; // app: strings are already UTF-8, the repair below would corrupt them\n');

// ── 3) The app starts unlocked: the real app has its own PIN/biometric
//       settings, and the mockup's demo lock (0000) would sit in front of them.
//       Locking on demand still works (Einstellungen -> Jetzt sperren, Spotlight).
patch('start unlocked', '<body class="is-locked">', '<body>');

// ── 3) Every card gets a PTY-backed sim instead of `null`.
patch('cardState (seed)',
  'cardState[s.id] = { lines: s.buffer.slice(), sim: null,',
  'cardState[s.id] = { lines: s.buffer.slice(), sim: window.__tmsSim(s.id),');
patch('cardState (new terminal)',
  'cardState[id] = { lines: session.buffer.slice(), sim: null,',
  'cardState[id] = { lines: session.buffer.slice(), sim: window.__tmsSim(id),');

// ── 3b) Die Bridge rendert die Terminalzeilen selbst (in genau der DOM-Form, für
//        die die Selektion des Mockups gebaut ist) und braucht dafür cardState.
patch('expose cardState', '  const cardState = {};', '  const cardState = {};\n  window.__tmsCardState = cardState;\n  window.__tmsState = state;');

// ── 4) The island assumed the demo's always-present live session; with real
//       sessions there may be none yet, and xterm — not cs.lines — holds the
//       output, so read the last line from the bridge.
patch('island live session',
  `    const live = TMS_DATA.sessions.find(s => s.live);
    const cs = cardState[live.id];
    const lastLine = cs.lines[cs.lines.length - 1] || '';`,
  `    const live = TMS_DATA.sessions.find(s => s.live) || TMS_DATA.sessions[0] || null;
    const lastLine = (live && window.__tmsLastLine && window.__tmsLastLine[live.id]) || '';`);

// ── 4b) The Deploys tab invented three fake releases; take the real ones when
//        React Native has fetched them (TMSBridge.setCloudDetail).
patch('cloud deploys', `    const deploys = [
      { version: 'v12', time: project.lastDeploy, status: project.status === 'building' ? 'building' : 'ready' },`,
  `    const deploys = project.deploys || [
      { version: 'v12', time: project.lastDeploy, status: project.status === 'building' ? 'building' : 'ready' },`);

// ── 5) Boot without the demo: no scripted session, no fake RTT jitter. Both
//       run inside the mockup's own script, i.e. before the bridge can replace
//       them, so they have to go here.
patch('demo boot', `  initLiveSession();
  startLatencyTicker();
  show('lock');`, `  // No initLiveSession()/startLatencyTicker(): real PTY output and the real ping
  // are pushed in by the bridge (TMSBridge.output / .setStatus). And no demo PIN
  // gate — the real app has its own security settings; "Jetzt sperren" still works.
  show('terminals');`);

// ── 5) xterm.js + the bridge, after the mockup's own script.
function stringExports(file) {
  const text = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
  const out = {};
  const re = /export const (\w+) = ("(?:[^"\\]|\\.)*");/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = JSON.parse(m[2]);
  return out;
}
const xterm = stringExports('../src/assets/xtermBundle.ts');
for (const k of ['XTERM_CSS', 'XTERM_XTERM', 'XTERM_FIT', 'XTERM_WEBLINKS']) {
  if (!xterm[k]) throw new Error(`xtermBundle.ts is missing ${k}`);
}

patch('body end', '</body>', `<style>${xterm.XTERM_CSS}
/* xterm rendert nichts mehr — es ist nur noch der Emulator, unsichtbar. Wir
   zeichnen die Zeilen selbst in genau die Form, für die die Selektion, die
   Griffe, die Kopieren-Bubble und der Jump-Orb des Mockups gebaut sind. */
#tmsEmulators { position: fixed; left: -99999px; top: 0; opacity: 0; pointer-events: none; }
#tmsEmulators textarea { pointer-events: auto; }
.card-body { -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
.card-body { overflow-x: hidden; }
/* Ein 16px-Griff ist für Finger zu klein: unsichtbare 44px-Trefferfläche. */
.sel-handle::after { content: ''; position: absolute; left: 50%; top: 50%; width: 44px; height: 44px;
  transform: translate(-50%, -50%); border-radius: 50%; }
/* Der Emulator hat schon umgebrochen — die CSS darf NICHT nochmal umbrechen. */
.card-body .term-line { display: block; white-space: pre; }
.card-body .term-line__text { white-space: pre; }
.up-progress { margin-bottom: 14px; }
.up-progress__bar { height: 6px; border-radius: 3px; background: rgba(var(--overlay-rgb),.14); overflow: hidden; }
.up-progress__bar span { display: block; height: 100%; border-radius: 3px; background: var(--accent); transition: width 260ms var(--spring); }
.up-progress__label { margin-top: 7px; text-align: center; font: 12px var(--font-ui); color: var(--text-dim); }
.shot-insert-all { width: 100%; padding: 13px; margin-bottom: 12px; border-radius: 14px; font: 600 13.5px var(--font-ui);
  color: var(--accent); background: rgba(var(--accent-rgb),.14); border: 1px solid rgba(var(--accent-rgb),.4); }
.shot-insert-all:active { transform: scale(.98); }
.shot-selbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.shot-tile { position: relative; }
.shot-tile .shot-tile__check { position: absolute; right: 6px; top: 6px; width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; font: 700 13px var(--font-ui); color: #fff;
  background: var(--accent); opacity: 0; transform: scale(.6); transition: opacity 160ms ease-out, transform 240ms cubic-bezier(.22,1,.36,1); }
.shot-tile.is-selected { outline: 2px solid var(--accent); outline-offset: -2px; }
.shot-tile.is-selected .shot-tile__check { opacity: 1; transform: scale(1); }
.shot-tile__video { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 26px; color: var(--text); background: rgba(var(--well-rgb),var(--well-a)); border-radius: inherit; }
.shot-choice { display: flex; gap: 10px; margin-bottom: 12px; }
.shot-choice__btn { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 10px;
  border-radius: 16px; background: rgba(var(--well-rgb),var(--well-a)); border: 1px solid var(--glass-border); color: var(--text); }
.shot-choice__btn span { font: 600 13px var(--font-ui); }
.shot-choice__btn small { font: 11px var(--font-ui); color: var(--text-dim); }
.shot-choice__btn:active { transform: scale(.97); }
.tool-empty { padding: 22px 8px; text-align: center; font: 12.5px var(--font-ui); color: var(--text-dim); }
/* Datei-Explorer */
.fx-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.fx-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
  font-size: 11.5px; color: var(--text-dim); }
.fx-search, .fx-input { width: 100%; padding: 9px 11px; margin-bottom: 8px; border-radius: 10px;
  background: rgba(var(--well-rgb),var(--well-a)); border: 1px solid var(--glass-border); color: var(--text); font: 13px var(--font-ui); }
.fx-input { margin: 0; flex: 1; }
.fx-favs { display: flex; gap: 6px; overflow-x: auto; margin-bottom: 8px; scrollbar-width: none; }
.fx-favs::-webkit-scrollbar { display: none; }
.fx-row { position: relative; }
.fx-row .tool-row { padding-right: 34px; }
.fx-more { position: absolute; right: 4px; top: 6px; width: 26px; height: 26px; border-radius: 8px; color: var(--text-dim);
  display: flex; align-items: center; justify-content: center; font-size: 15px; }
.fx-more:active { background: rgba(var(--overlay-rgb),.12); }
.fx-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 6px 10px; }
.btn-chip--danger { color: var(--danger); border-color: rgba(var(--danger-rgb),.4); }
.fx-preview { max-height: 46vh; overflow: auto; margin-top: 8px; padding: 10px; border-radius: 10px; white-space: pre-wrap;
  background: rgba(var(--well-rgb),var(--well-a)); font-size: 11.5px; line-height: 1.5; color: var(--text); }
</style>
<script>${xterm.XTERM_XTERM}</script>
<script>${xterm.XTERM_FIT}</script>
<script>${bridgeJs}</script>
</body>`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `/**
 * GENERATED — do not edit. Source: mockups/season2/liquid-deck/index.html
 * Rebuild: npm run build:season2
 *
 * This IS the mockup — same markup, CSS, animations, gestures. Only the demo
 * layer is swapped: real xterm.js terminals and a bridge to the real backend.
 */
export const LIQUID_DECK_HTML = ${JSON.stringify(html)};
`);
console.log(`built ${path.relative(process.cwd(), OUT)} (${(html.length / 1024).toFixed(0)} KB)`);
