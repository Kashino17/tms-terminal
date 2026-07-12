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
window.TMS_DATA.sessions = [];
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
for (const k of ['XTERM_CSS', 'XTERM_XTERM', 'XTERM_FIT']) {
  if (!xterm[k]) throw new Error(`xtermBundle.ts is missing ${k}`);
}

patch('body end', '</body>', `<style>${xterm.XTERM_CSS}
/* An xterm inside a mockup .card-body: transparent, edge to edge, its own scroll. */
.card-body.is-xterm { padding: 8px 10px; overflow: hidden; }
.card-body.is-xterm .xterm { height: 100%; }
.card-body.is-xterm .xterm-viewport { background: transparent !important; overflow-y: auto; }
.card-body.is-xterm .xterm-screen { width: 100% !important; }
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
