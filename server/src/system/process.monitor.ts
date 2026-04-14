import { exec as execCb } from 'child_process';
import * as os from 'os';
import { getPlatform } from '../utils/platform';

// ── Interfaces ──────────────────────────────────────────────────────

export interface SystemStats {
  cpuPercent: number;
  memPercent: number;
  memUsedMB: number;
  memTotalMB: number;
  diskPercent: number;
  uptime: string;
  loadAvg: number[];
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  mem: number;
  user: string;
}

export interface ProcessSnapshot {
  system: SystemStats;
  processes: ProcessInfo[];
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Async exec wrapped in a Promise — used for heavy commands. */
function execAsync(cmd: string, timeout = 5000): Promise<string> {
  return new Promise((resolve) => {
    execCb(cmd, { encoding: 'utf-8', timeout }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? '').trim());
    });
  });
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// ── Signal whitelist ────────────────────────────────────────────────

const ALLOWED_SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGSTOP', 'SIGCONT', 'SIGUSR1', 'SIGUSR2'];

// ── macOS (darwin) ──────────────────────────────────────────────────

async function getDarwinCpu(): Promise<number> {
  try {
    const raw = await execAsync('top -l 1 -n 0 -s 0');
    // Line like: "CPU usage: 5.26% user, 10.52% sys, 84.21% idle"
    const match = raw.match(/CPU usage:\s+([\d.]+)%\s+user,\s+([\d.]+)%\s+sys/);
    if (match) {
      return parseFloat(match[1]) + parseFloat(match[2]);
    }
  } catch { /* fallback */ }
  return 0;
}

async function getDarwinMemory(): Promise<{ usedMB: number; totalMB: number; percent: number }> {
  const totalMB = Math.round(os.totalmem() / (1024 * 1024));
  try {
    const raw = await execAsync('vm_stat');
    const pageSize = 16384; // Apple Silicon default; fallback
    const pageSizeMatch = raw.match(/page size of (\d+) bytes/);
    const pSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : pageSize;

    const free = raw.match(/Pages free:\s+(\d+)/);
    const inactive = raw.match(/Pages inactive:\s+(\d+)/);
    const speculative = raw.match(/Pages speculative:\s+(\d+)/);

    const freePages = (free ? parseInt(free[1], 10) : 0)
      + (inactive ? parseInt(inactive[1], 10) : 0)
      + (speculative ? parseInt(speculative[1], 10) : 0);

    const freeMB = Math.round((freePages * pSize) / (1024 * 1024));
    const usedMB = totalMB - freeMB;
    const percent = Math.round((usedMB / totalMB) * 100 * 10) / 10;

    return { usedMB, totalMB, percent };
  } catch {
    const freeMB = Math.round(os.freemem() / (1024 * 1024));
    const usedMB = totalMB - freeMB;
    return { usedMB, totalMB, percent: Math.round((usedMB / totalMB) * 100 * 10) / 10 };
  }
}

// ── Linux ───────────────────────────────────────────────────────────

async function getLinuxCpu(): Promise<number> {
  try {
    const raw = await execAsync('top -bn1 | head -5');
    // Line like: "%Cpu(s):  3.1 us,  1.0 sy, ..."
    const match = raw.match(/%?Cpu\(s\):\s+([\d.]+)\s+us,\s+([\d.]+)\s+sy/);
    if (match) {
      return parseFloat(match[1]) + parseFloat(match[2]);
    }
  } catch { /* fallback */ }
  return 0;
}

async function getLinuxMemory(): Promise<{ usedMB: number; totalMB: number; percent: number }> {
  try {
    const raw = await execAsync('free -m');
    // Mem:  total  used  free  shared  buff/cache  available
    const match = raw.match(/Mem:\s+(\d+)\s+(\d+)/);
    if (match) {
      const totalMB = parseInt(match[1], 10);
      const usedMB = parseInt(match[2], 10);
      const percent = Math.round((usedMB / totalMB) * 100 * 10) / 10;
      return { usedMB, totalMB, percent };
    }
  } catch { /* fallback */ }

  const totalMB = Math.round(os.totalmem() / (1024 * 1024));
  const freeMB = Math.round(os.freemem() / (1024 * 1024));
  const usedMB = totalMB - freeMB;
  return { usedMB, totalMB, percent: Math.round((usedMB / totalMB) * 100 * 10) / 10 };
}

// ── Disk usage ──────────────────────────────────────────────────────

async function getDiskPercent(): Promise<number> {
  const platform = getPlatform();
  try {
    if (platform === 'win32') {
      const raw = await execAsync('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace,Size /format:value');
      const free = parseInt(raw.match(/FreeSpace=(\d+)/)?.[1] ?? '0', 10);
      const size = parseInt(raw.match(/Size=(\d+)/)?.[1] ?? '1', 10);
      return size ? Math.round((1 - free / size) * 100) : 0;
    } else {
      // Works on macOS and Linux: df -k /
      const raw = await execAsync('df -k /');
      const parts = raw.trim().split('\n')[1]?.split(/\s+/) ?? [];
      const used = parseInt(parts[2] ?? '0', 10);
      const avail = parseInt(parts[3] ?? '0', 10);
      const total = used + avail;
      return total ? Math.round((used / total) * 100) : 0;
    }
  } catch {
    return 0;
  }
}

// ── Process list (shared parsing, different flags) ──────────────────

async function getProcesses(platform: string): Promise<ProcessInfo[]> {
  try {
    let raw: string;
    if (platform === 'darwin') {
      raw = await execAsync('ps aux -r');
    } else {
      raw = await execAsync('ps aux --sort=-%cpu');
    }

    const lines = raw.split('\n');
    // Skip header line
    const dataLines = lines.slice(1).filter((l) => l.trim().length > 0);
    const top20 = dataLines.slice(0, 20);

    return top20.map((line) => {
      // ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
      const parts = line.trim().split(/\s+/);
      const user = parts[0] || '';
      const pid = parseInt(parts[1], 10) || 0;
      const cpu = parseFloat(parts[2]) || 0;
      const mem = parseFloat(parts[3]) || 0;
      // Command is everything from index 10 onward (may contain spaces)
      const name = parts.slice(10).join(' ') || parts[10] || '';

      return { pid, name, cpu, mem, user };
    });
  } catch {
    return [];
  }
}

// ── Public API ──────────────────────────────────────────────────────

export async function getProcessSnapshot(): Promise<ProcessSnapshot> {
  const platform = getPlatform();

  let cpuPercent = 0;
  let memInfo = { usedMB: 0, totalMB: 0, percent: 0 };

  if (platform === 'darwin') {
    [cpuPercent, memInfo] = await Promise.all([getDarwinCpu(), getDarwinMemory()]);
  } else {
    // linux (and fallback)
    [cpuPercent, memInfo] = await Promise.all([getLinuxCpu(), getLinuxMemory()]);
  }

  cpuPercent = Math.round(cpuPercent * 10) / 10;

  const [diskPercent, processes] = await Promise.all([getDiskPercent(), getProcesses(platform)]);

  const system: SystemStats = {
    cpuPercent,
    memPercent: memInfo.percent,
    memUsedMB: memInfo.usedMB,
    memTotalMB: memInfo.totalMB,
    diskPercent,
    uptime: formatUptime(os.uptime()),
    loadAvg: os.loadavg().map((v) => Math.round(v * 100) / 100),
  };

  return { system, processes };
}

export async function killProcess(
  pid: number,
  signal: string = 'SIGTERM',
): Promise<{ ok: boolean; error?: string }> {
  // Validate pid is a positive integer
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: `Invalid PID: ${pid}` };
  }

  // Validate signal against whitelist
  if (!ALLOWED_SIGNALS.includes(signal)) {
    return { ok: false, error: `Disallowed signal: ${signal}. Allowed: ${ALLOWED_SIGNALS.join(', ')}` };
  }

  try {
    // Use Node's process.kill — no shell involved, no injection possible
    process.kill(pid, signal as NodeJS.Signals);
    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `Failed to kill process ${pid}`,
    };
  }
}
