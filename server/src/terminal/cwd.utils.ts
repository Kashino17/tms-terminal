import { exec as execCb } from 'child_process';
import * as os from 'os';

function execAsync(cmd: string, timeout = 2000): Promise<string> {
  return new Promise((resolve) => {
    execCb(cmd, { encoding: 'utf8', timeout }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? '').trim());
    });
  });
}

/** Read the working directory of a process by PID.
 *  Works on Linux (procfs) and macOS (lsof).
 *  Returns null on failure or unsupported platform. */
export async function readProcessCwd(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const platform = os.platform();
    if (platform === 'linux') {
      const result = await execAsync(`readlink /proc/${pid}/cwd`, 1000);
      return result || null;
    } else if (platform === 'darwin') {
      const out = await execAsync(`lsof -p ${pid} -a -d cwd -F n`, 2000);
      // lsof -F n outputs lines like "n/path/to/dir"
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
  if (!Number.isInteger(shellPid) || shellPid <= 0) return null;
  try {
    // Find direct children of the shell process
    const raw = await execAsync(`pgrep -P ${shellPid}`, 1000);

    if (raw) {
      const childPid = raw.split('\n')[0].trim();
      const name = await execAsync(`ps -p ${childPid} -o comm=`, 1000);
      return name || null;
    }
  } catch {
    // shell is idle or pgrep/ps unavailable
  }

  // Fall back to the shell's own name
  try {
    const shellName = await execAsync(`ps -p ${shellPid} -o comm=`, 1000);
    return shellName || null;
  } catch {
    return null;
  }
}
