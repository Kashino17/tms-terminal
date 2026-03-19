import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, exec } from 'child_process';
import { logger } from '../utils/logger';
import { fcmService } from '../notifications/fcm.service';

// ── Path security ─────────────────────────────────────────────────────────────
const DENIED_PATHS = [
  '.tms-terminal',
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gcloud',
  '.env',
  '.netrc',
  '.npmrc',
];

function isWithinHome(resolved: string): boolean {
  const home = os.homedir();
  const normalized = path.resolve(resolved);
  return normalized === home || normalized.startsWith(home + path.sep);
}

function isDeniedPath(resolved: string): boolean {
  const home = os.homedir();
  const rel = path.relative(home, resolved);
  return DENIED_PATHS.some(denied => rel === denied || rel.startsWith(denied + path.sep));
}

function isAllowedWatcherPath(resolved: string): boolean {
  return isWithinHome(resolved) && !isDeniedPath(resolved);
}

const MAX_PATTERN_LENGTH = 200;

// ── Types ────────────────────────────────────────────────────────────────────
export type WatcherType = 'file' | 'process' | 'keyword';

export interface WatcherConfig {
  id: string;
  type: WatcherType;
  label: string;
  enabled: boolean;
  config: Record<string, string>;
}

interface ActiveWatcher {
  watcher: WatcherConfig;
  cleanup: () => void;
}

// ── Persistence ──────────────────────────────────────────────────────────────
const WATCHERS_DIR = path.join(os.homedir(), '.tms-terminal');
const WATCHERS_FILE = path.join(WATCHERS_DIR, 'watchers.json');

function loadWatchers(): WatcherConfig[] {
  try {
    if (fs.existsSync(WATCHERS_FILE)) {
      return JSON.parse(fs.readFileSync(WATCHERS_FILE, 'utf-8'));
    }
  } catch { /* corrupted file — start fresh */ }
  return [];
}

function saveWatchers(watchers: WatcherConfig[]): void {
  if (!fs.existsSync(WATCHERS_DIR)) {
    fs.mkdirSync(WATCHERS_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(WATCHERS_FILE, JSON.stringify(watchers, null, 2), { mode: 0o600 });
}

// ── Watcher Service ──────────────────────────────────────────────────────────
class WatcherService {
  private watchers: WatcherConfig[] = [];
  private active = new Map<string, ActiveWatcher>();
  private deviceToken: string | null = null;

  init(): void {
    this.watchers = loadWatchers();
    // Start all enabled watchers
    for (const w of this.watchers) {
      if (w.enabled) this.startWatcher(w);
    }
    logger.info(`Watchers: ${this.watchers.length} loaded, ${this.active.size} active`);
  }

  setDeviceToken(token: string): void {
    this.deviceToken = token;
  }

  getAll(): WatcherConfig[] {
    return this.watchers;
  }

  create(watcher: WatcherConfig): void {
    this.watchers.push(watcher);
    saveWatchers(this.watchers);
    if (watcher.enabled) this.startWatcher(watcher);
    logger.success(`Watcher created: ${watcher.label} (${watcher.type})`);
  }

  update(id: string, updates: Partial<WatcherConfig>): WatcherConfig | null {
    const idx = this.watchers.findIndex((w) => w.id === id);
    if (idx === -1) return null;

    const old = this.watchers[idx];
    const updated = { ...old, ...updates };
    this.watchers[idx] = updated;
    saveWatchers(this.watchers);

    // Handle enable/disable
    if (old.enabled && !updated.enabled) {
      this.stopWatcher(id);
    } else if (!old.enabled && updated.enabled) {
      this.startWatcher(updated);
    }

    return updated;
  }

  delete(id: string): boolean {
    this.stopWatcher(id);
    const before = this.watchers.length;
    this.watchers = this.watchers.filter((w) => w.id !== id);
    saveWatchers(this.watchers);
    return this.watchers.length < before;
  }

  test(id: string): void {
    const w = this.watchers.find((w) => w.id === id);
    if (!w) return;
    this.notify(w, 'Test notification — your watcher is working!');
  }

  shutdown(): void {
    for (const [id] of this.active) {
      this.stopWatcher(id);
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private notify(watcher: WatcherConfig, message: string): void {
    if (!this.deviceToken) {
      logger.warn(`Watcher notify: no device token for "${watcher.label}"`);
      return;
    }
    const typeLabel = watcher.type === 'file' ? 'File Change'
      : watcher.type === 'process' ? 'Process Alert'
      : 'Log Match';
    fcmService.send(
      this.deviceToken,
      `🔔 ${typeLabel}: ${watcher.label}`,
      message,
      { watcherId: watcher.id, watcherType: watcher.type },
    ).catch(() => {});
  }

  private startWatcher(watcher: WatcherConfig): void {
    if (this.active.has(watcher.id)) return;

    try {
      switch (watcher.type) {
        case 'file':
          this.startFileWatcher(watcher);
          break;
        case 'process':
          this.startProcessWatcher(watcher);
          break;
        case 'keyword':
          this.startKeywordWatcher(watcher);
          break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Watcher start failed (${watcher.label}): ${msg}`);
    }
  }

  private stopWatcher(id: string): void {
    const active = this.active.get(id);
    if (active) {
      active.cleanup();
      this.active.delete(id);
      logger.info(`Watcher stopped: ${active.watcher.label}`);
    }
  }

  // ── File Change Watcher ────────────────────────────────────────────────────
  private startFileWatcher(watcher: WatcherConfig): void {
    const filePath = watcher.config.path;
    if (!filePath) return;

    // Expand ~ to home directory
    const resolved = filePath.startsWith('~')
      ? path.join(os.homedir(), filePath.slice(1))
      : filePath;

    if (!isAllowedWatcherPath(resolved)) {
      logger.warn(`Watcher: path denied — ${resolved}`);
      return;
    }

    if (!fs.existsSync(resolved)) {
      logger.warn(`Watcher: path not found — ${resolved}`);
      // Still register — file might be created later
    }

    let debounceTimer: NodeJS.Timeout | null = null;
    const fsWatcher = fs.watch(resolved, { persistent: true, recursive: false }, (eventType) => {
      // Debounce — editors often write multiple times rapidly
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.notify(watcher, `${path.basename(resolved)} was ${eventType === 'rename' ? 'renamed/created' : 'modified'}`);
      }, 500);
    });

    fsWatcher.on('error', (err) => {
      logger.warn(`Watcher error (${watcher.label}): ${err.message}`);
    });

    this.active.set(watcher.id, {
      watcher,
      cleanup: () => {
        fsWatcher.close();
        if (debounceTimer) clearTimeout(debounceTimer);
      },
    });

    logger.info(`File watcher started: ${resolved}`);
  }

  // ── Process Crash Watcher ──────────────────────────────────────────────────
  private startProcessWatcher(watcher: WatcherConfig): void {
    const processName = watcher.config.name;
    if (!processName) return;

    let wasRunning = false;
    // Initialize wasRunning asynchronously
    this.isProcessRunning(processName).then(running => { wasRunning = running; });
    const interval = setInterval(() => {
      this.isProcessRunning(processName).then(isRunning => {
        if (wasRunning && !isRunning) {
          this.notify(watcher, `Process '${processName}' has stopped or crashed!`);
        }
        wasRunning = isRunning;
      });
    }, 5000); // Check every 5 seconds

    this.active.set(watcher.id, {
      watcher,
      cleanup: () => clearInterval(interval),
    });

    logger.info(`Process watcher started: ${processName} (currently ${wasRunning ? 'running' : 'not found'})`);
  }

  private isProcessRunning(name: string): Promise<boolean> {
    // Sanitize process name to prevent shell injection
    const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!sanitized) return Promise.resolve(false);

    return new Promise((resolve) => {
      exec(
        process.platform === 'win32'
          ? `tasklist /FI "IMAGENAME eq ${sanitized}*" /NH`
          : `pgrep -f "${sanitized}"`,
        { encoding: 'utf-8', timeout: 3000 },
        (error, stdout) => {
          if (error) { resolve(false); return; }
          resolve(stdout.trim().length > 0);
        },
      );
    });
  }

  // ── Log Keyword Watcher ────────────────────────────────────────────────────
  private startKeywordWatcher(watcher: WatcherConfig): void {
    const logFile = watcher.config.file;
    const pattern = watcher.config.pattern;
    if (!logFile || !pattern) return;

    const resolved = logFile.startsWith('~')
      ? path.join(os.homedir(), logFile.slice(1))
      : logFile;

    if (!isAllowedWatcherPath(resolved)) {
      logger.warn(`Watcher: path denied — ${resolved}`);
      return;
    }

    let regex: RegExp;
    // Reject overly complex patterns to prevent ReDoS
    if (pattern.length > MAX_PATTERN_LENGTH) {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } else {
      try {
        regex = new RegExp(pattern, 'i');
      } catch {
        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }
    }

    // Use tail -F to follow the log file (works even if the file is rotated)
    const tail = spawn('tail', ['-F', '-n', '0', resolved], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let lineBuffer = '';
    let debounceTimer: NodeJS.Timeout | null = null;

    tail.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      if (lineBuffer.length > 1_048_576) lineBuffer = '';
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (regex.test(line)) {
          // Debounce — avoid flooding for rapid matches
          if (debounceTimer) clearTimeout(debounceTimer);
          const matchedLine = line.trim().slice(0, 200);
          debounceTimer = setTimeout(() => {
            this.notify(watcher, `Match in ${path.basename(resolved)}: ${matchedLine}`);
          }, 1000);
        }
      }
    });

    tail.on('error', (err) => {
      logger.warn(`Keyword watcher error (${watcher.label}): ${err.message}`);
    });

    this.active.set(watcher.id, {
      watcher,
      cleanup: () => {
        tail.kill('SIGTERM');
        if (debounceTimer) clearTimeout(debounceTimer);
      },
    });

    logger.info(`Keyword watcher started: ${resolved} → /${pattern}/i`);
  }
}

export const watcherService = new WatcherService();
