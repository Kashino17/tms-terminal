import { execFile as execFileCb } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

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

/** Read the name of the foreground process running inside a shell.
 *  If the shell has a child process (e.g., vim, npm), returns that child's name.
 *  If the shell is idle, returns the shell's own name. */
export async function readForegroundProcess(shellPid: number): Promise<string | null> {
  const pidStr = safePid(shellPid);
  if (!pidStr) return null;
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
