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
    const existingPid = readPid();
    if (existingPid && isRunning(existingPid)) {
      console.log(`\x1b[33m⚠\x1b[0m  TMS Terminal is already running (PID ${existingPid}).`);
      process.exit(1);
    }

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
    const pid = readPid();
    if (!pid || !isRunning(pid)) {
      console.log('\x1b[90mTMS Terminal is not running.\x1b[0m');
      cleanPid();
      process.exit(0);
    }

    try {
      process.kill(pid, 'SIGTERM');
      console.log(`\x1b[32m✓\x1b[0m  TMS Terminal stopped (PID ${pid}).`);
      cleanPid();
    } catch (err) {
      console.error('\x1b[31m✗\x1b[0m  Failed to stop:', err.message);
      process.exit(1);
    }
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

    // Stop server if running
    const updatePid = readPid();
    if (updatePid && isRunning(updatePid)) {
      console.log('\x1b[34m⟳\x1b[0m  Stopping server...');
      try { process.kill(updatePid, 'SIGTERM'); } catch {}
      cleanPid();
    }

    try {
      // Pull latest code
      console.log('\x1b[34m⟳\x1b[0m  Pulling latest changes...');
      execSync('git pull', { cwd: ROOT, stdio: 'inherit' });

      // Install any new dependencies
      console.log('\x1b[34m⟳\x1b[0m  Installing dependencies...');
      execSync('npm install', { cwd: ROOT, stdio: 'inherit' });

      // Rebuild
      console.log('\x1b[34m⟳\x1b[0m  Rebuilding...');
      // Remove old build to force full recompile
      const distDir = path.join(ROOT, 'dist');
      if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
      execSync('npx tsc', { cwd: ROOT, stdio: 'inherit' });

      // Show version from package.json
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      console.log(`\x1b[32m✓\x1b[0m  TMS Terminal updated to v${pkg.version}`);

      // Re-exec using the UPDATED cli.js (git pull may have changed it)
      // This ensures the start logic uses the latest code
      console.log('\x1b[34m⟳\x1b[0m  Starting server...');
      const updatedCli = path.join(ROOT, 'bin', 'cli.js');
      const child = spawn('node', [updatedCli, 'start'], {
        stdio: 'inherit',
        cwd: ROOT,
      });
      child.on('exit', (code) => process.exit(code ?? 0));
      process.on('SIGINT', () => child.kill('SIGINT'));
      process.on('SIGTERM', () => child.kill('SIGTERM'));
    } catch (err) {
      console.error('\x1b[31m✗\x1b[0m  Update failed:', err.message);
      process.exit(1);
    }
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
