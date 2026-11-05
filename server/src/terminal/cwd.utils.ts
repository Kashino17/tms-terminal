import { execFile as execFileCb } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

/** Collapse the user's home directory to `~` for compact display.
 *  `/Users/x` -> `~`, `/Users/x/proj` -> `~/proj`, other paths unchanged.
 *  Only collapses at a path boundary so `/Users/x-backup` is left intact. */
export function normalizeCwd(p: string, home: string = os.homedir()): string {
  if (!p) return p;
  const clean = p.length > 1 ? p.replace(/\/+$/, '') : p;
  if (clean === home) return '~';
  if (clean.startsWith(home + '/')) return '~' + clean.slice(home.length);
  return clean;
}

/** Safe exec helper — uses execFile (no shell) to prevent command injection. */
function execFileAsync(bin: string, args: string[], timeout = 2000): Promise<string> {
  return new Promise((resolve) => {
    execFileCb(bin, args, { encoding: 'utf8', timeout }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? '').trim());
    });
  });
}

/** Validate that a value is a safe positive integer PID. */
function safePid(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 4194304) return null;
  return String(pid);
}

/** Read the working directory of a process by PID.
 *  Works on Linux (procfs) and macOS (lsof).
 *  Returns null on failure or unsupported platform. */
export async function readProcessCwd(pid: number): Promise<string | null> {
  const pidStr = safePid(pid);
  if (!pidStr) return null;
  try {
    const platform = os.platform();
    if (platform === 'linux') {
      // Use fs.readlink instead of spawning a shell
      return await fs.promises.readlink(`/proc/${pidStr}/cwd`).catch(() => null);
    } else if (platform === 'darwin') {
      const out = await execFileAsync('lsof', ['-p', pidStr, '-a', '-d', 'cwd', '-F', 'n'], 2000);
      const match = out.match(/^n(.+)$/m);
      return match?.[1]?.trim() ?? null;
    }
  } catch {
    // process may have already exited, or permission denied
  }
  return null;
}

/** Konsolen-Helfer, die unter einer Windows-Shell hängen, aber nie das sind,
 *  was der Nutzer "laufen" sieht. */
const WIN_HELPERS = new Set(['conhost.exe', 'openconsole.exe']);

/** Vordergrundprogramm aus einer Windows-Prozesstabelle ("pid,ppid,name" je
 *  Zeile): der TIEFSTE Nachfahre der Shell. Mit npm installiert läuft OpenCode
 *  als pwsh → node.exe → opencode.exe; das direkte Kind wäre nur der Starter.
 *  Ohne Nachfahren: der Name der Shell selbst. */
export function pickForegroundFromTable(table: string, shellPid: number): string | null {
  const names = new Map<number, string>();
  const children = new Map<number, number[]>();
  for (const line of table.split(/\r?\n/)) {
    const m = /^\s*(\d+),(\d+),(.+?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]);
    names.set(pid, m[3]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  if (!names.has(shellPid)) return null;
  let best = shellPid, bestDepth = 0;
  const stack: Array<[number, number]> = [[shellPid, 0]];
  const seen = new Set<number>();
  while (stack.length) {
    const [pid, depth] = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const kid of children.get(pid) ?? []) {
      if (WIN_HELPERS.has((names.get(kid) ?? '').toLowerCase())) continue;
      if (depth + 1 >= bestDepth) { best = kid; bestDepth = depth + 1; }
      stack.push([kid, depth + 1]);
    }
  }
  return names.get(best) ?? null;
}

/** Read the name of the foreground process running inside a shell.
 *  If the shell has a child process (e.g., vim, npm), returns that child's name.
 *  If the shell is idle, returns the shell's own name. */
export async function readForegroundProcess(shellPid: number): Promise<string | null> {
  const pidStr = safePid(shellPid);
  if (!pidStr) return null;
  // Windows hat weder pgrep noch ps — ohne diesen Zweig blieb der Prozessname
  // dort immer leer, und die App wusste nie, dass OpenCode läuft (kein
  // erzwungener Maus-Modus → Tippen/Wischen kamen nie an).
  if (os.platform() === 'win32') {
    const table = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }',
    ], 5000);
    return pickForegroundFromTable(table, Number(pidStr));
  }
  try {
    const raw = await execFileAsync('pgrep', ['-P', pidStr], 1000);

    if (raw) {
      const childPidStr = raw.split('\n')[0].trim();
      if (!/^\d+$/.test(childPidStr)) return null;
      const name = await execFileAsync('ps', ['-p', childPidStr, '-o', 'comm='], 1000);
      return name || null;
    }
  } catch {
    // shell is idle or pgrep/ps unavailable
  }

  try {
    const shellName = await execFileAsync('ps', ['-p', pidStr, '-o', 'comm='], 1000);
    return shellName || null;
  } catch {
    return null;
  }
}
