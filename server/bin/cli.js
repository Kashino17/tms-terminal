#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(os.homedir(), '.tms-terminal');
const PID_FILE = path.join(CONFIG_DIR, 'server.pid');
const DIST_INDEX = path.join(ROOT, 'dist', 'server', 'src', 'index.js');
const DIST_SETUP = path.join(ROOT, 'dist', 'server', 'src', 'setup.js');
const DIST_DIR = path.join(ROOT, 'dist');
const TSBUILDINFO = path.join(ROOT, '.tsbuildinfo');

// ── Helpers ──────────────────────────────────────────────────────────────────
function getPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
    return cfg.port || 8767;
  } catch { return 8767; }
}

/** Kill whatever is listening on the server port (PID file OR lsof fallback). */
function stopExisting() {
  // 1. Try PID file
  const pid = readPid();
  if (pid && isRunning(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    cleanPid();
  }

  // 2. Fallback: kill whatever holds the port (handles orphaned processes)
  const port = getPort();
  try {
    const pids = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (pids) {
      pids.split('\n').forEach((p) => {
        const n = parseInt(p, 10);
        if (n > 0) try { process.kill(n, 'SIGTERM'); } catch {}
      });
    }
  } catch {} // lsof not found or no process — fine

  // 3. Wait up to 2s for the port to be released
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf8' });
      // Still occupied — wait a bit
      execSync('sleep 0.2');
    } catch {
      break; // Port is free
    }
  }
}

function ensureBuilt() {
  if (!fs.existsSync(DIST_INDEX)) {
    console.log('\x1b[34m⟳\x1b[0m  Building TMS Terminal...');
    // Ensure dependencies are installed first
    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
      console.log('\x1b[34m⟳\x1b[0m  Installing dependencies...');
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
      console.error('\x1b[31m✗\x1b[0m  Build failed.');
      process.exit(1);
    }
    if (!fs.existsSync(DIST_INDEX)) {
      console.error('\x1b[31m✗\x1b[0m  Build produced no output (' + DIST_INDEX + ').');
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

// ── Commands ─────────────────────────────────────────────────────────────────
const command = process.argv[2] || 'start';

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
    // Kill anything still holding the port (stale PID, orphaned process, etc.)
    stopExisting();

    ensureBuilt();

    const child = spawn('node', [DIST_INDEX], {
      stdio: 'inherit',
      cwd: ROOT,
    });

    writePid(child.pid);

    child.on('exit', (code) => {
      cleanPid();
      process.exit(code ?? 0);
    });

    // Forward signals so Ctrl+C stops the server gracefully
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    break;
  }

  // ── tms-terminal stop ───────────────────────────────────────────────────
  case 'stop': {
    stopExisting();
    console.log('\x1b[32m✓\x1b[0m  TMS Terminal stopped.');
    break;
  }

  // ── tms-terminal status ─────────────────────────────────────────────────
  case 'status': {
    const pid = readPid();
    if (pid && isRunning(pid)) {
      console.log(`\x1b[32m●\x1b[0m  TMS Terminal is running (PID ${pid}).`);
    } else {
      console.log('\x1b[90m●  TMS Terminal is not running.\x1b[0m');
      if (pid) cleanPid();
    }
    break;
  }

  // ── tms-terminal uninstall ──────────────────────────────────────────────
  case 'uninstall': {
    // Stop server if running
    const uPid = readPid();
    if (uPid && isRunning(uPid)) {
      try { process.kill(uPid, 'SIGTERM'); } catch {}
      cleanPid();
      console.log('\x1b[32m✓\x1b[0m  Server stopped.');
    }

    // Remove config directory (~/.tms-terminal)
    if (fs.existsSync(CONFIG_DIR)) {
      fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
      console.log('\x1b[32m✓\x1b[0m  Config removed (~/.tms-terminal)');
    }

    // Unlink global binary
    try {
      execSync('npm uninstall -g tms-terminal', { stdio: 'inherit' });
      console.log('\x1b[32m✓\x1b[0m  Global command removed.');
    } catch {}

    console.log('\x1b[32m✓\x1b[0m  TMS Terminal fully uninstalled.');
    console.log('\x1b[90m   To also remove the source code: rm -rf ' + ROOT + '\x1b[0m');
    break;
  }

  // ── tms-terminal rebuild ────────────────────────────────────────────────
  case 'rebuild': {
    console.log('\x1b[34m⟳\x1b[0m  Rebuilding TMS Terminal...');
    try {
      execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
      console.log('\x1b[32m✓\x1b[0m  Build complete.');
    } catch {
      console.error('\x1b[31m✗\x1b[0m  Build failed.');
      process.exit(1);
    }
    break;
  }

  // ── tms-terminal update ────────────────────────────────────────────────
  case 'update': {
    console.log('\x1b[34m⟳\x1b[0m  Updating TMS Terminal...');

    // Write a self-contained update script that survives server/PTY death.
    // This is critical for remote updates (e.g., from the mobile app's terminal):
    // when the server stops, the PTY dies, but the detached script keeps running.
    const UPDATE_LOG = path.join(CONFIG_DIR, 'update.log');
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
  nohup node "${CLI_PATH}" start >> "${UPDATE_LOG}" 2>&1 &
  exit 1
}
mv -f "${NEW_TSBUILDINFO}" "${TSBUILDINFO}" 2>/dev/null || true

echo "[$(date)] Starte Server..."
nohup node "${CLI_PATH}" start >> "${UPDATE_LOG}" 2>&1 &
sleep 4

# ── Phase 3: kommt er wirklich hoch? Sonst zurueck auf den alten Stand. ──

if node "${CLI_PATH}" status | grep -q "is running"; then
  echo "[$(date)] Server laeuft wieder (v$VERSION). Update fertig."
  rm -rf "${OLD_DIST}"
else
  echo "[$(date)] Der neue Server kommt nicht hoch — ZURUECK auf den alten Stand."
  node "${CLI_PATH}" stop 2>/dev/null || true
  rm -rf "${DIST_DIR}"
  mv "${OLD_DIST}" "${DIST_DIR}" 2>/dev/null || true
  nohup node "${CLI_PATH}" start >> "${UPDATE_LOG}" 2>&1 &
  sleep 4
  node "${CLI_PATH}" status
  echo "[$(date)] Zurueckgerollt. Der Fehler steht weiter oben in diesem Log."
  exit 1
fi
`;

    fs.writeFileSync(UPDATE_SCRIPT, script, { mode: 0o755 });

    // Trockenlauf: schreibt das Skript, führt es aber nicht aus. Damit lässt sich
    // nachsehen (und prüfen), was ein Update tun WÜRDE, ohne den Server anzufassen.
    if (process.env.TMS_UPDATE_DRY_RUN) {
      console.log(`\x1b[33m⟳\x1b[0m  Trockenlauf — Skript geschrieben, nicht ausgeführt:\n   ${UPDATE_SCRIPT}`);
      break;
    }

    console.log('\x1b[34m⟳\x1b[0m  Update läuft im Hintergrund...');
    console.log('\x1b[90m   Der Server bleibt an, bis der neue Stand fertig gebaut ist —\x1b[0m');
    console.log('\x1b[90m   dann kurzer Neustart. Scheitert etwas, läuft er unverändert weiter.\x1b[0m');
    console.log(`\x1b[90m   Log: ${UPDATE_LOG}\x1b[0m`);

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
  default:
    console.log(`
\x1b[1mTMS Terminal\x1b[0m – Remote Terminal Server

\x1b[1mUsage:\x1b[0m
  tms-terminal              Start the server
  tms-terminal setup        Configure password & port
  tms-terminal stop         Stop the running server
  tms-terminal status       Check if server is running
  tms-terminal update       Pull, rebuild alongside, then swap + restart
                            (server stays up until the new build is proven;
                             rolls back if it fails to come up)
  tms-terminal rebuild      Recompile TypeScript
  tms-terminal uninstall    Remove everything (config, global command)

\x1b[1mInstall:\x1b[0m
  npm install && npm link   Install globally from source
  tms-terminal setup        First-time configuration
  tms-terminal              Start serving
`);
}
