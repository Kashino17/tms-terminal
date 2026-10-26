#!/usr/bin/env node

const { spawn, execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(os.homedir(), '.tms-terminal');
const PID_FILE = path.join(CONFIG_DIR, 'server.pid');
const DIST_INDEX = path.join(ROOT, 'dist', 'server', 'src', 'index.js');
const DIST_SETUP = path.join(ROOT, 'dist', 'server', 'src', 'setup.js');
const DIST_DIR = path.join(ROOT, 'dist');
const TSBUILDINFO = path.join(ROOT, '.tsbuildinfo');
const LOG_DIR = path.join(CONFIG_DIR, 'logs');
const SERVER_LOG = path.join(LOG_DIR, 'server.log');
const KEEPER_LOG = path.join(CONFIG_DIR, 'ptyd.log');
const UPDATE_LOG = path.join(CONFIG_DIR, 'update.log');
const TITLES_FILE = path.join(CONFIG_DIR, 'titles.json');
const LOG_ROTATE_BYTES = 20 * 1024 * 1024;

// Same rule as server/src/index.ts: Unix socket paths are limited to 104
// characters on macOS — an unusually long home directory falls back to /tmp.
const KEEPER_SOCK = (() => {
  const preferred = path.join(CONFIG_DIR, 'ptyd.sock');
  return preferred.length <= 100 ? preferred : path.join('/tmp', `tms-ptyd-${process.getuid ? process.getuid() : 'u'}.sock`);
})();

// ── Output helpers ───────────────────────────────────────────────────────────
const TTY = process.stdout.isTTY;
const paint = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { green: paint(32), red: paint(31), yellow: paint(33), blue: paint(34), gray: paint(90), bold: paint(1) };
const ok = (msg) => console.log(`${c.green('✓')}  ${msg}`);
const bad = (msg) => console.log(`${c.red('✗')}  ${msg}`);
const warn = (msg) => console.log(`${c.yellow('!')}  ${msg}`);
const info = (msg) => console.log(`${c.blue('⟳')}  ${msg}`);
const hint = (msg) => console.log(c.gray(`   ${msg}`));

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : (argv.includes('-h') || argv.includes('--help') ? 'help' : argv.includes('-v') || argv.includes('--version') ? 'version' : 'start');
const rest = argv[0] === command ? argv.slice(1) : argv;
const has = (...names) => names.some((n) => rest.includes(n));
function optValue(name, fallback) {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
    return cfg.port || 8767;
  } catch { return 8767; }
}

function listenerPids(port) {
  try {
    return execSync(`lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8' })
      .trim().split('\n').map((p) => parseInt(p, 10)).filter((n) => n > 0);
  } catch { return []; }
}

/** Kill whatever is listening on the server port (PID file OR lsof fallback). */
function stopExisting() {
  let stopped = false;
  // 1. Try PID file
  const pid = readPid();
  if (pid && isRunning(pid)) {
    try { process.kill(pid, 'SIGTERM'); stopped = true; } catch {}
    cleanPid();
  }

  // 2. Fallback: kill whatever LISTENS on the port (handles orphaned servers).
  //    Only the listener: terminals now outlive the server (terminal keeper,
  //    server/src/terminal/ptyd), and a program in one of them with an open
  //    connection TO the server must not be killed by a restart.
  const port = getPort();
  for (const n of listenerPids(port)) {
    try { process.kill(n, 'SIGTERM'); stopped = true; } catch {}
  }

  // 3. Wait up to 5s for the port to be released (graceful shutdown saves state first)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && listenerPids(port).length > 0) {
    execSync('sleep 0.2');
  }
  return stopped;
}

function ensureBuilt() {
  if (!fs.existsSync(DIST_INDEX)) {
    info('Baue TMS Terminal...');
    // Ensure dependencies are installed first
    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
      info('Installiere Abhängigkeiten...');
      execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
    }
    // dist is missing here, so force a real emit: a stale .tsbuildinfo would
    // make `tsc` a no-op (it tracks emit state, not output existence) and the
    // server would then crash with MODULE_NOT_FOUND. Treat dist + .tsbuildinfo
    // as a unit.
    try { fs.unlinkSync(TSBUILDINFO); } catch {}
    try {
      execSync('npx tsc', { cwd: ROOT, stdio: 'inherit' });
    } catch {
      bad('Build fehlgeschlagen.');
      process.exit(1);
    }
    if (!fs.existsSync(DIST_INDEX)) {
      bad('Build hat keine Ausgabe erzeugt (' + DIST_INDEX + ').');
      process.exit(1);
    }
  }
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function writePid(pid) {
  ensureConfigDir();
  fs.writeFileSync(PID_FILE, String(pid));
}

function readPid() {
  try {
    return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanPid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

/** The server's pid if it runs (PID file, else whoever listens on the port). */
function serverPid() {
  const pid = readPid();
  if (pid && isRunning(pid)) return pid;
  const l = listenerPids(getPort());
  return l.length ? l[0] : null;
}

function elapsed(pid) {
  try {
    // ps etime: [[DD-]HH:]MM:SS
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(execSync(`ps -o etime= -p ${pid}`, { encoding: 'utf8' }).trim());
    if (!m) return '?';
    const secs = ((+m[1] || 0) * 86400) + ((+m[2] || 0) * 3600) + (+m[3] * 60) + (+m[4]);
    return fmtAge(secs * 1000);
  } catch { return '?'; }
}

function fmtAge(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} T ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

function fmtBytes(n) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

function version() {
  let v = '?';
  try { v = require(path.join(ROOT, 'package.json')).version; } catch {}
  let git = '';
  try {
    const opts = { cwd: ROOT, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] };
    const br = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
    const sha = execSync('git rev-parse --short HEAD', opts).trim();
    git = `${br} @ ${sha}`;
  } catch {}
  return { v, git };
}

function rotateLog(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, file + '.1');
  } catch {}
}

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

function waitForPort(port, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (listenerPids(port).length) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

function confirm(question) {
  if (has('-y', '--yes')) return Promise.resolve(true);
  if (!process.stdin.isTTY) {
    bad('Keine Rückfrage möglich (kein Terminal) — mit --yes bestätigen.');
    return Promise.resolve(false);
  }
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(`${question} [j/N] `, (a) => { rl.close(); resolve(/^(j|ja|y|yes)$/i.test(a.trim())); }));
}

// ── Terminal keeper (ptyd) ───────────────────────────────────────────────────
/** One-shot status from the keeper — never attaches, so a running server stays connected. */
function keeperInfo() {
  return new Promise((resolve) => {
    let done = false, buf = '';
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const sock = net.createConnection(KEEPER_SOCK);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write('{"t":"info"}\n'));
    sock.on('data', (d) => {
      buf += d;
      const line = buf.split('\n')[0];
      try { const m = JSON.parse(line); if (m.t === 'info') { finish(m); sock.destroy(); } } catch {}
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
    setTimeout(() => { finish(null); sock.destroy(); }, 1500);
  });
}

function keeperPidsByName() {
  try {
    return execSync('pgrep -f "terminal/ptyd/daemon"', { encoding: 'utf8' }).trim().split('\n').map((x) => parseInt(x, 10)).filter((n) => n > 0);
  } catch { return []; }
}

/** Process table once: pid → {ppid, comm}. */
function processTable() {
  const map = new Map();
  try {
    for (const line of execSync('ps -A -o pid=,ppid=,comm=', { encoding: 'utf8' }).split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) map.set(Number(m[1]), { ppid: Number(m[2]), comm: path.basename(m[3].trim()) });
    }
  } catch {}
  return map;
}

function cwdsOf(pids) {
  const out = {};
  if (!pids.length) return out;
  try {
    const txt = execSync(`lsof -a -d cwd -p ${pids.join(',')} -Fpn 2>/dev/null`, { encoding: 'utf8' });
    let cur = null;
    for (const l of txt.split('\n')) {
      if (l[0] === 'p') cur = Number(l.slice(1));
      else if (l[0] === 'n' && cur) out[cur] = l.slice(1);
    }
  } catch {}
  return out;
}

function readTitles() {
  try { return JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')); } catch { return {}; }
}

function printTerminals(ki) {
  if (!ki.sessions.length) { hint('keine Terminals'); return; }
  const titles = readTitles();
  const ps = processTable();
  const cwds = cwdsOf(ki.sessions.map((s) => s.pid).filter(Boolean));
  const home = os.homedir();
  for (const s of ki.sessions) {
    const kids = [...ps].filter(([, p]) => p.ppid === s.pid).map(([, p]) => p.comm).filter((x) => !/^(zsh|bash|sh|-zsh)$/.test(x));
    const title = titles[s.id] || c.gray('(ohne Titel)');
    const cwd = (cwds[s.pid] || '').replace(home, '~');
    const what = kids.length ? c.blue(kids.join(', ')) : c.gray('Shell');
    console.log(`   ${c.bold(title)}  ${what}  ${c.gray(cwd)}`);
    console.log(c.gray(`      ${s.id.slice(0, 8)} · pid ${s.pid} · ${s.cols}×${s.rows}${s.buffered ? ` · ${fmtBytes(s.buffered)} gepuffert` : ''}`));
  }
}

async function stopKeeper() {
  const ki = await keeperInfo();
  const pids = ki ? [ki.pid] : keeperPidsByName();
  if (!pids.length) { hint('Der Wächter läuft nicht.'); return true; }
  const n = ki ? ki.sessions.length : null;
  const what = n === null ? 'alle Terminals' : n === 1 ? '1 Terminal' : `${n} Terminals`;
  warn(`Das beendet den Wächter und damit ${what} — samt allem, was darin läuft (z. B. Claude).`);
  if (!(await confirm('Wirklich beenden?'))) { hint('Abgebrochen, nichts beendet.'); return false; }
  for (const p of pids) { try { process.kill(p, 'SIGTERM'); } catch {} }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && pids.some(isRunning)) await new Promise((r) => setTimeout(r, 150));
  if (pids.some(isRunning)) { bad('Der Wächter reagiert nicht — erzwinge das Ende.'); for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch {} } }
  ok(`Wächter beendet (${what}).`);
  return true;
}

function tailFile(file, lines, follow, clean) {
  if (!fs.existsSync(file)) { bad(`Log gibt es (noch) nicht: ${file}`); return false; }
  const txt = fs.readFileSync(file, 'utf8');
  let out = txt.split('\n');
  if (out[out.length - 1] === '') out.pop();
  out = out.slice(-lines);
  process.stdout.write((clean ? out.map(stripAnsi) : out).join('\n') + '\n');
  if (!follow) return true;
  let pos = fs.statSync(file).size;
  fs.watchFile(file, { interval: 400 }, (cur) => {
    if (cur.size < pos) pos = 0; // rotiert
    if (cur.size === pos) return;
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(cur.size - pos);
    fs.readSync(fd, b, 0, b.length, pos);
    fs.closeSync(fd);
    pos = cur.size;
    process.stdout.write(clean ? stripAnsi(b.toString('utf8')) : b.toString('utf8'));
  });
  return true;
}

// ── Commands ─────────────────────────────────────────────────────────────────
async function main() {
  switch (command) {

  // ── tms-terminal setup ──────────────────────────────────────────────────
  case 'setup': {
    ensureBuilt();
    const child = spawn('node', [DIST_SETUP], {
      stdio: 'inherit',
      cwd: ROOT,
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    break;
  }

  // ── tms-terminal (start) ────────────────────────────────────────────────
  case 'start': {
    const background = has('-d', '--background', '--detach');
    // Kill anything still holding the port (stale PID, orphaned process, etc.)
    if (serverPid()) info('Ein laufender Server wird ersetzt (Terminals laufen im Wächter weiter).');
    stopExisting();

    ensureBuilt();
    rotateLog(SERVER_LOG);

    if (background) {
      const out = fs.openSync(SERVER_LOG, 'a');
      const child = spawn('node', [DIST_INDEX], { detached: true, stdio: ['ignore', out, out], cwd: ROOT });
      child.unref();
      fs.closeSync(out);
      writePid(child.pid);
      const port = getPort();
      if (await waitForPort(port, 20000)) {
        ok(`Server läuft im Hintergrund (PID ${child.pid}, Port ${port}).`);
        hint(`Log: tms-terminal logs -f`);
        process.exit(0);
      }
      bad('Der Server ist nicht hochgekommen.');
      hint('Letzte Log-Zeilen:');
      tailFile(SERVER_LOG, 15, false, true);
      process.exit(1);
    }

    // Vordergrund: Ausgabe wie gewohnt im Fenster UND in die Log-Datei — so
    // lässt sich später nachlesen, was passiert ist (tms-terminal logs).
    const log = fs.createWriteStream(SERVER_LOG, { flags: 'a' });
    const child = spawn('node', [DIST_INDEX], {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: ROOT,
    });
    child.stdout.on('data', (d) => { process.stdout.write(d); log.write(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); log.write(d); });

    writePid(child.pid);

    child.on('exit', (code) => {
      cleanPid();
      log.end(() => process.exit(code ?? 0));
    });

    // Forward signals so Ctrl+C stops the server gracefully
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    break;
  }

  // ── tms-terminal restart ────────────────────────────────────────────────
  case 'restart': {
    // Geht auch aus einem Terminal der App heraus: die Terminals gehören dem
    // Wächter, nicht dem Server — dieser Befehl überlebt also den Neustart.
    info('Starte den Server neu (Terminals laufen weiter)...');
    stopExisting();
    const out = fs.openSync(path.join(os.tmpdir(), `tms-restart-${process.pid}.log`), 'w');
    const child = spawn(process.execPath, [__filename, 'start', '--background'], { detached: true, stdio: ['ignore', out, out] });
    child.unref();
    fs.closeSync(out);
    const port = getPort();
    if (await waitForPort(port, 25000)) {
      ok(`Server läuft wieder (Port ${port}).`);
      process.exit(0);
    }
    bad('Der Server ist nicht wieder hochgekommen — siehe: tms-terminal logs');
    process.exit(1);
  }

  // ── tms-terminal stop ───────────────────────────────────────────────────
  case 'stop': {
    const all = has('-a', '--all');
    const was = stopExisting();
    if (was) ok('Server gestoppt.'); else hint('Der Server lief nicht.');
    if (all) { if (!(await stopKeeper())) process.exit(1); }
    else {
      const ki = await keeperInfo();
      if (ki && ki.sessions.length) hint(`${ki.sessions.length} Terminal(s) laufen im Wächter weiter. Alles beenden: tms-terminal stop --all`);
    }
    break;
  }

  // ── tms-terminal status ─────────────────────────────────────────────────
  case 'status': {
    const pid = serverPid();
    const port = getPort();
    // Alte Update-Skripte suchen "is running" in dieser Ausgabe — die Zeile
    // bleibt fuer umgeleitete Ausgabe erhalten, sonst rollte ein Update von
    // einer aelteren Version faelschlich zurueck.
    if (!TTY) console.log(pid ? `TMS Terminal is running (PID ${pid}).` : 'TMS Terminal is not running.');
    if (has('-q', '--quiet')) process.exit(pid ? 0 : 1);

    const { v, git } = version();
    console.log(`\n${c.bold('TMS Terminal')} ${c.gray(`v${v}${git ? ' · ' + git : ''}`)}\n`);
    if (pid) {
      const listening = listenerPids(port).length > 0;
      console.log(`${c.green('●')}  Server läuft ${c.gray(`· PID ${pid} · seit ${elapsed(pid)} · Port ${port}${listening ? '' : ' (lauscht NICHT)'}`)}`);
    } else {
      console.log(`${c.gray('●')}  Server läuft nicht ${c.gray('· starten: tms-terminal')}`);
    }
    const ki = await keeperInfo();
    if (ki) {
      console.log(`${c.green('●')}  Wächter läuft ${c.gray(`· PID ${ki.pid} · seit ${fmtAge(Date.now() - ki.startedAt)} · ${ki.sessions.length} Terminal(s)${ki.serverAttached ? '' : ' · kein Server verbunden'}`)}`);
      if (!has('--short')) printTerminals(ki);
    } else if (keeperPidsByName().length) {
      console.log(`${c.yellow('●')}  Wächter läuft ${c.gray('· älterer Stand ohne Auskunft')}`);
    } else {
      console.log(`${c.gray('●')}  Wächter läuft nicht ${c.gray('· startet mit dem Server')}`);
    }
    try {
      const st = fs.statSync(SERVER_LOG);
      console.log(c.gray(`\n   Log: ${SERVER_LOG.replace(os.homedir(), '~')} (${fmtBytes(st.size)}) — tms-terminal logs -f`));
    } catch {}
    console.log('');
    process.exit(pid ? 0 : 1);
  }

  // ── tms-terminal terminals ──────────────────────────────────────────────
  case 'terminals':
  case 'ls': {
    const ki = await keeperInfo();
    if (!ki) { bad('Der Wächter läuft nicht (oder antwortet nicht).'); process.exit(1); }
    console.log(`\n${c.bold(`${ki.sessions.length} Terminal(s)`)} ${c.gray(`im Wächter (PID ${ki.pid})`)}\n`);
    printTerminals(ki);
    console.log('');
    break;
  }

  // ── tms-terminal keeper [status|stop|logs] ──────────────────────────────
  case 'keeper':
  case 'waechter':
  case 'wächter': {
    const sub = rest.find((a) => !a.startsWith('-')) || 'status';
    if (sub === 'stop') { const done = await stopKeeper(); process.exit(done ? 0 : 1); }
    if (sub === 'logs' || sub === 'log') { tailFile(KEEPER_LOG, parseInt(optValue('-n', '60'), 10) || 60, has('-f', '--follow'), !TTY); break; }
    if (sub !== 'status') { bad(`Unbekannt: keeper ${sub}`); hint('keeper status | keeper stop | keeper logs [-f]'); process.exit(2); }
    const ki = await keeperInfo();
    if (!ki) {
      const byName = keeperPidsByName();
      if (byName.length) warn(`Wächter läuft (PID ${byName.join(', ')}), gibt aber keine Auskunft (älterer Stand).`);
      else console.log(`${c.gray('●')}  Wächter läuft nicht — er startet mit dem Server (tms-terminal).`);
      break;
    }
    console.log(`\n${c.green('●')}  Wächter läuft ${c.gray(`· PID ${ki.pid} · seit ${fmtAge(Date.now() - ki.startedAt)} · Protokoll v${ki.v}`)}`);
    console.log(`   Server ${ki.serverAttached ? c.green('verbunden') : c.yellow('nicht verbunden')} · Socket ${c.gray(KEEPER_SOCK.replace(os.homedir(), '~'))}\n`);
    printTerminals(ki);
    console.log(c.gray(`\n   Herunterfahren (beendet alle Terminals): tms-terminal keeper stop\n`));
    break;
  }

  // ── tms-terminal logs [server|keeper|update] [-f] [-n N] ────────────────
  case 'logs':
  case 'log': {
    const which = rest.find((a) => !a.startsWith('-') && !/^\d+$/.test(a)) || 'server';
    const file = { server: SERVER_LOG, keeper: KEEPER_LOG, waechter: KEEPER_LOG, update: UPDATE_LOG }[which];
    if (!file) { bad(`Unbekanntes Log: ${which}`); hint('logs [server|keeper|update] [-f] [-n 200]'); process.exit(2); }
    const n = parseInt(optValue('-n', '100'), 10) || 100;
    if (!tailFile(file, n, has('-f', '--follow'), !TTY)) {
      if (which === 'server') hint('Das Log entsteht ab dem nächsten Start mit dieser Version (tms-terminal).');
      process.exit(1);
    }
    break;
  }

  // ── tms-terminal doctor / debug ─────────────────────────────────────────
  case 'doctor':
  case 'debug': {
    const { v, git } = version();
    console.log(`\n${c.bold('TMS Terminal — Selbsttest')} ${c.gray(`v${v}${git ? ' · ' + git : ''} · Node ${process.version} · ${os.platform()} ${os.release()}`)}\n`);
    let problems = 0;
    const check = (good, msg, fix) => { if (good) ok(msg); else { bad(msg); if (fix) hint(fix); problems++; } };
    const note = (msg, sub) => { warn(msg); if (sub) hint(sub); };

    // Build
    const built = fs.existsSync(DIST_INDEX);
    check(built, built ? 'Build vorhanden' : 'Build fehlt', 'tms-terminal rebuild');
    if (built && fs.existsSync(TSBUILDINFO)) {
      const srcNewer = (() => { try { return execSync(`find src -name '*.ts' -newer "${DIST_INDEX}" | head -1`, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; } })();
      if (srcNewer) note('Quelltext ist neuer als der Build', `z. B. ${srcNewer} — neu bauen: tms-terminal rebuild`);
    }
    // Config
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8')); } catch {}
    check(!!cfg.passwordHash, cfg.passwordHash ? 'Passwort eingerichtet' : 'Kein Passwort eingerichtet', 'tms-terminal setup');
    check(!!cfg.jwtSecret, cfg.jwtSecret ? 'Anmelde-Schlüssel vorhanden' : 'Anmelde-Schlüssel fehlt', 'tms-terminal setup');
    // Server + Port
    const port = getPort();
    const pid = serverPid();
    check(!!pid, pid ? `Server läuft (PID ${pid}, seit ${elapsed(pid)})` : 'Server läuft nicht', 'starten: tms-terminal');
    if (pid) {
      const health = await new Promise((resolve) => {
        const req = require('http').get({ host: '127.0.0.1', port, path: '/health', timeout: 3000 }, (res) => { resolve(res.statusCode); res.resume(); });
        req.on('error', () => resolve(0));
        req.on('timeout', () => { req.destroy(); resolve(0); });
      });
      check(health === 200, health === 200 ? `Port ${port} antwortet (/health)` : `Port ${port} antwortet nicht (/health: ${health || 'keine Antwort'})`, 'Log ansehen: tms-terminal logs');
    }
    // Keeper
    const ki = await keeperInfo();
    if (ki) ok(`Wächter läuft (PID ${ki.pid}, ${ki.sessions.length} Terminal(s)${ki.serverAttached ? ', Server verbunden' : ', KEIN Server verbunden'})`);
    else if (keeperPidsByName().length) note('Wächter läuft, antwortet aber nicht auf Auskunft (älterer Stand)');
    else if (os.platform() !== 'win32') note('Wächter läuft nicht', 'startet automatisch mit dem Server');
    // Remote helper (macOS)
    if (os.platform() === 'darwin') {
      const helper = path.join(ROOT, 'bin', 'tms-remote-helper');
      check(fs.existsSync(helper), fs.existsSync(helper) ? 'Fernzugriff-Helfer gebaut' : 'Fernzugriff-Helfer fehlt', `bash ${path.join(ROOT, 'src/remote/helpers/mac/build.sh')}`);
      if (fs.existsSync(helper)) hint('Freigaben (Bildschirmaufnahme, Bedienungshilfen) prüft erst eine echte Sitzung.');
    }
    if (os.platform() === 'win32') {
      let ff = '';
      try { ff = execSync('ffmpeg -version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0]; } catch {}
      const major = parseInt((/ffmpeg version (\d+)/.exec(ff) || [])[1] || '0', 10);
      check(major >= 6, ff ? `ffmpeg ${major}` : 'ffmpeg fehlt', 'Fernzugriff braucht ffmpeg >= 6 (ddagrab)');
    }
    // Tailscale
    try {
      const ts = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const self = ts.Self || {};
      ok(`Tailscale: ${self.HostName || '?'} (${(self.TailscaleIPs || [])[0] || '?'})`);
      for (const p of Object.values(ts.Peer || {})) {
        if (!p.Online) continue;
        const direct = p.CurAddr && p.CurAddr !== '';
        const via = direct ? `direkt (${p.CurAddr})` : p.PeerRelay ? `Peer-Relay ${p.PeerRelay}` : p.Relay ? `über Relais ${p.Relay} — langsamer` : 'noch keine Verbindung';
        (direct ? ok : warn)(`   ${p.HostName}: ${via}`);
      }
    } catch {
      note('Tailscale nicht gefunden oder nicht erreichbar', 'ohne Tailnet geht der Zugriff von unterwegs nicht');
    }
    // Logs
    for (const [name, file] of [['Server', SERVER_LOG], ['Wächter', KEEPER_LOG], ['Update', UPDATE_LOG]]) {
      try { const st = fs.statSync(file); hint(`${name}-Log: ${file.replace(os.homedir(), '~')} (${fmtBytes(st.size)}, ${new Date(st.mtimeMs).toLocaleString('de-DE')})`); } catch {}
    }

    if (command === 'debug') {
      // Zum Weitergeben: die letzten Auffaelligkeiten aus den Logs.
      for (const [name, file] of [['Server', SERVER_LOG], ['Wächter', KEEPER_LOG], ['Update', UPDATE_LOG]]) {
        if (!fs.existsSync(file)) continue;
        const lines = stripAnsi(fs.readFileSync(file, 'utf8')).split('\n');
        const hits = lines.filter((l) => /\b(WARN|ERROR|Error|Fehler|ABBRUCH|beendet|crash)/.test(l) && !/notification skipped/.test(l)).slice(-15);
        console.log(`\n${c.bold(`Letzte Auffälligkeiten — ${name}`)}`);
        if (hits.length) hits.forEach((l) => console.log(c.gray('   ' + l.slice(0, 200)))); else hint('keine');
      }
    }
    console.log(problems ? `\n${c.red(`${problems} Problem(e) gefunden.`)}\n` : `\n${c.green('Alles in Ordnung.')}\n`);
    process.exit(problems ? 1 : 0);
  }

  // ── tms-terminal version ────────────────────────────────────────────────
  case 'version': {
    const { v, git } = version();
    console.log(`tms-terminal v${v}${git ? ` (${git})` : ''}`);
    break;
  }

  // ── tms-terminal uninstall ──────────────────────────────────────────────
  case 'uninstall': {
    // Stop server if running
    const uPid = readPid();
    if (uPid && isRunning(uPid)) {
      try { process.kill(uPid, 'SIGTERM'); } catch {}
      cleanPid();
      ok('Server gestoppt.');
    }
    // Der Wächter haelt Terminals — ohne Konfigurationsordner waere er verwaist.
    if ((await keeperInfo()) || keeperPidsByName().length) {
      if (!(await stopKeeper())) { hint('Deinstallation abgebrochen.'); process.exit(1); }
    }

    // Remove config directory (~/.tms-terminal)
    if (fs.existsSync(CONFIG_DIR)) {
      fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
      ok('Konfiguration entfernt (~/.tms-terminal)');
    }

    // Unlink global binary
    try {
      execSync('npm uninstall -g tms-terminal', { stdio: 'inherit' });
      ok('Globaler Befehl entfernt.');
    } catch {}

    ok('TMS Terminal vollständig deinstalliert.');
    hint('Auch den Quelltext löschen: rm -rf ' + ROOT);
    break;
  }

  // ── tms-terminal rebuild ────────────────────────────────────────────────
  case 'rebuild': {
    info('Baue TMS Terminal neu...');
    try {
      execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
      ok('Build fertig.');
      if (serverPid()) hint('Aktiv wird er nach einem Neustart: tms-terminal restart');
    } catch {
      bad('Build fehlgeschlagen.');
      process.exit(1);
    }
    break;
  }

  // ── tms-terminal update ────────────────────────────────────────────────
  case 'update': {
    info('Aktualisiere TMS Terminal...');

    // Write a self-contained update script that survives server/PTY death.
    // This is critical for remote updates (e.g., from the mobile app's terminal):
    // when the server stops, the PTY dies, but the detached script keeps running.
    const UPDATE_SCRIPT = path.join(CONFIG_DIR, 'update.sh');
    const CLI_PATH = path.join(ROOT, 'bin', 'cli.js');

    ensureConfigDir();

    // Der Server laeuft weiter, solange noch irgendetwas schiefgehen kann.
    // Frueher war es umgekehrt: erst stoppen, dann pullen und bauen — scheiterte
    // eine dieser Stufen (Konflikt im Arbeitsbaum, kaputte Referenz, kein Netz,
    // Build-Fehler), blieb der Server AUS. Aus der Ferne, mit dem Handy in der
    // Hand, ist das der schlimmste Ausgang: kein Terminal mehr, um es zu richten.
    //
    // Jetzt: pullen, installieren und NEBEN dem laufenden dist bauen. Erst wenn
    // der neue Stand fertig und der Einstiegspunkt da ist, wird getauscht — und
    // kommt der neue Server nicht hoch, wird das alte dist zurueckgerollt.
    // Die Terminals selbst laufen im Waechter und ueberstehen den Tausch.
    const NEW_DIST = path.join(ROOT, 'dist.new');
    const NEW_TSBUILDINFO = path.join(ROOT, '.tsbuildinfo.new');
    const NEW_INDEX = path.join(NEW_DIST, 'server', 'src', 'index.js');
    const OLD_DIST = path.join(ROOT, 'dist.old');

    const script = `#!/bin/bash
exec > "${UPDATE_LOG}" 2>&1
echo "[$(date)] Update gestartet"

cd "${ROOT}" || exit 1

# ── Phase 1: alles, was scheitern darf. Der Server laeuft dabei weiter. ──

echo "[$(date)] Hole neuen Stand..."
git pull || { echo "[$(date)] ABBRUCH: git pull fehlgeschlagen. Der Server laeuft unveraendert weiter."; exit 1; }

echo "[$(date)] Installiere Abhaengigkeiten..."
npm install --no-audit --no-fund || { echo "[$(date)] ABBRUCH: npm install fehlgeschlagen. Der Server laeuft unveraendert weiter."; exit 1; }

echo "[$(date)] Baue neben dem laufenden Server..."
rm -rf "${NEW_DIST}" "${NEW_TSBUILDINFO}"
npx tsc --outDir "${NEW_DIST}" --tsBuildInfoFile "${NEW_TSBUILDINFO}" || {
  echo "[$(date)] ABBRUCH: Build fehlgeschlagen. Der Server laeuft unveraendert weiter."
  rm -rf "${NEW_DIST}" "${NEW_TSBUILDINFO}"
  exit 1
}
if [ ! -f "${NEW_INDEX}" ]; then
  echo "[$(date)] ABBRUCH: Der Build hat keinen Einstiegspunkt erzeugt. Der Server laeuft unveraendert weiter."
  rm -rf "${NEW_DIST}" "${NEW_TSBUILDINFO}"
  exit 1
fi

VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")
echo "[$(date)] v$VERSION ist fertig gebaut. Erst JETZT wird der Server angefasst."

# ── Phase 2: der kurze Tausch. Ab hier ist der Server kurz weg. ──

node "${CLI_PATH}" stop 2>/dev/null || true
sleep 1

rm -rf "${OLD_DIST}"
mv "${DIST_DIR}" "${OLD_DIST}" 2>/dev/null || true
mv "${NEW_DIST}" "${DIST_DIR}" || {
  echo "[$(date)] Tausch fehlgeschlagen — rolle zurueck."
  mv "${OLD_DIST}" "${DIST_DIR}" 2>/dev/null || true
  node "${CLI_PATH}" start --background
  exit 1
}
mv -f "${NEW_TSBUILDINFO}" "${TSBUILDINFO}" 2>/dev/null || true

echo "[$(date)] Starte Server..."
node "${CLI_PATH}" start --background

# ── Phase 3: kommt er wirklich hoch? Sonst zurueck auf den alten Stand. ──

if node "${CLI_PATH}" status --quiet; then
  echo "[$(date)] Server laeuft wieder (v$VERSION). Update fertig."
  rm -rf "${OLD_DIST}"
else
  echo "[$(date)] Der neue Server kommt nicht hoch — ZURUECK auf den alten Stand."
  node "${CLI_PATH}" stop 2>/dev/null || true
  rm -rf "${DIST_DIR}"
  mv "${OLD_DIST}" "${DIST_DIR}" 2>/dev/null || true
  node "${CLI_PATH}" start --background
  node "${CLI_PATH}" status --short
  echo "[$(date)] Zurueckgerollt. Der Fehler steht im Server-Log (tms-terminal logs)."
  exit 1
fi
`;

    fs.writeFileSync(UPDATE_SCRIPT, script, { mode: 0o755 });

    // Trockenlauf: schreibt das Skript, führt es aber nicht aus. Damit lässt sich
    // nachsehen (und prüfen), was ein Update tun WÜRDE, ohne den Server anzufassen.
    if (process.env.TMS_UPDATE_DRY_RUN || has('--dry-run')) {
      warn(`Trockenlauf — Skript geschrieben, nicht ausgeführt:\n   ${UPDATE_SCRIPT}`);
      break;
    }

    info('Update läuft im Hintergrund...');
    hint('Der Server bleibt an, bis der neue Stand fertig gebaut ist —');
    hint('dann kurzer Neustart. Scheitert etwas, läuft er unverändert weiter.');
    hint('Deine Terminals laufen im Wächter weiter.');
    hint('Verlauf: tms-terminal logs update -f');

    // Spawn fully detached — survives PTY death, server stop, everything
    const child = spawn('bash', [UPDATE_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      cwd: ROOT,
    });
    child.unref();

    // Give the user a moment to read the message, then exit
    setTimeout(() => process.exit(0), 500);
    break;
  }

  // ── help ────────────────────────────────────────────────────────────────
  case 'help': {
    printHelp();
    break;
  }

  default:
    bad(`Unbekannter Befehl: ${command}`);
    printHelp();
    process.exit(2);
  }
}

function printHelp() {
  const b = c.bold, g = c.gray;
  console.log(`
${b('TMS Terminal')} ${g('– Terminal-Server für die TMS-App')}

${b('Server')}
  tms-terminal                 Server starten (Ausgabe im Fenster + Log-Datei)
  tms-terminal start -d        Server im Hintergrund starten
  tms-terminal restart         Server neu starten (im Hintergrund) — geht auch
                               aus der App heraus, die Terminals laufen weiter
  tms-terminal stop            Server anhalten — die Terminals laufen weiter
  tms-terminal stop --all      Server UND alle Terminals beenden (fragt nach)
  tms-terminal status          Server, Wächter und alle Terminals auf einen Blick

${b('Terminals & Wächter')}
  tms-terminal terminals       Laufende Terminals (Titel, Programm, Ordner)
  tms-terminal keeper          Zustand des Wächters, der die Terminals hält
  tms-terminal keeper stop     Wächter herunterfahren — beendet ALLE Terminals
  tms-terminal keeper logs     Log des Wächters (-f zum Mitlesen)

${b('Fehlersuche')}
  tms-terminal logs            Server-Log, letzte 100 Zeilen
      -f                         live mitlesen      -n 300   mehr Zeilen
      keeper | update            Log des Wächters bzw. des letzten Updates
  tms-terminal doctor          Selbsttest: Build, Konfiguration, Port, Wächter,
                               Fernzugriff-Helfer, Tailscale-Verbindungen
  tms-terminal debug           Selbsttest + letzte Warnungen/Fehler aus den Logs

${b('Einrichtung & Pflege')}
  tms-terminal setup           Passwort und Port einrichten
  tms-terminal update          Neuen Stand holen, daneben bauen, tauschen
                               (bei Fehlern läuft der alte Server weiter)
  tms-terminal rebuild         TypeScript neu übersetzen
  tms-terminal version         Version und Git-Stand
  tms-terminal uninstall       Alles entfernen (Konfiguration, globaler Befehl)

${g('Rückfragen überspringen: --yes · Dateien: ~/.tms-terminal/')}
`);
}

main().catch((e) => { bad(e && e.message ? e.message : String(e)); process.exit(1); });
