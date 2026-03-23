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
    try {
      execSync('npx tsc', { cwd: ROOT, stdio: 'inherit' });
    } catch {
      console.error('\x1b[31m✗\x1b[0m  Build failed.');
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

    const script = `#!/bin/bash
exec > "${UPDATE_LOG}" 2>&1
echo "[$(date)] Update started"

cd "${ROOT}" || exit 1

# 1. Stop server (kill by PID + port fallback)
echo "[$(date)] Stopping server..."
node "${CLI_PATH}" stop 2>/dev/null || true
sleep 1

# 2. Pull latest code
echo "[$(date)] Pulling latest changes..."
git pull || { echo "FAILED: git pull"; exit 1; }

# 3. Install dependencies
echo "[$(date)] Installing dependencies..."
npm install --no-audit --no-fund || { echo "FAILED: npm install"; exit 1; }

# 4. Rebuild
echo "[$(date)] Rebuilding..."
rm -rf "${path.join(ROOT, 'dist')}"
npx tsc || { echo "FAILED: tsc build"; exit 1; }

# 5. Read new version
VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")
echo "[$(date)] Updated to v$VERSION"

# 6. Start server (detached)
echo "[$(date)] Starting server..."
nohup node "${CLI_PATH}" start >> "${UPDATE_LOG}" 2>&1 &
echo "[$(date)] Server started (PID $!)"
echo "[$(date)] Update complete"
`;

    fs.writeFileSync(UPDATE_SCRIPT, script, { mode: 0o755 });

    console.log('\x1b[34m⟳\x1b[0m  Update wird im Hintergrund ausgeführt...');
    console.log('\x1b[34m⟳\x1b[0m  Der Server startet automatisch neu.');
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
  tms-terminal update       Pull latest code, rebuild, restart
  tms-terminal rebuild      Recompile TypeScript
  tms-terminal uninstall    Remove everything (config, global command)

\x1b[1mInstall:\x1b[0m
  npm install && npm link   Install globally from source
  tms-terminal setup        First-time configuration
  tms-terminal              Start serving
`);
}
