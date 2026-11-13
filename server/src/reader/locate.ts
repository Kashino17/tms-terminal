/**
 * From a terminal to the conversation log of the Claude session running in it.
 *
 * Several terminals often sit in the SAME folder, so "newest log in that
 * project" would show the wrong conversation. The process tree is exact:
 * terminal shell → its descendants → the one that registered itself in
 * ~/.claude/sessions/<pid>.json (Claude Code writes {pid, sessionId, cwd} there
 * for every interactive session) → projects/<folder>/<sessionId>.jsonl.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

export interface Proc { pid: number; ppid: number; name: string }

/** Why there is nothing to read. */
export type NoTranscript =
  | 'no-claude'      // no Claude Code runs in this terminal
  | 'no-transcript'  // Claude runs but keeps no log (e.g. started with inherited session markers)
  | 'empty';         // the session exists, nothing has been written yet

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

/** Lines of "pid ppid name" (name may contain spaces). */
export function parseProcessList(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] });
  }
  return procs;
}

export function listProcesses(): Promise<Proc[]> {
  return new Promise((resolve) => {
    const done = (err: Error | null, stdout: string): void => resolve(err ? [] : parseProcessList(stdout));
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'],
      { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, done);
    } else {
      execFile('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, done);
    }
  });
}

/** Every process below `root`, nearest generation first. */
export function descendants(procs: Proc[], root: number): Proc[] {
  const byParent = new Map<number, Proc[]>();
  for (const p of procs) { const l = byParent.get(p.ppid); if (l) l.push(p); else byParent.set(p.ppid, [p]); }
  const out: Proc[] = [];
  const seen = new Set<number>([root]);
  let level = [root];
  while (level.length) {
    const next: number[] = [];
    for (const pid of level) for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid); out.push(child); next.push(child.pid);
    }
    level = next;
  }
  return out;
}

const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

function logFileOf(configDir: string, sessionId: string, cwd: string): string | null {
  const projects = path.join(configDir, 'projects');
  const direct = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId + '.jsonl');
  if (fs.existsSync(direct)) return direct;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(projects); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(projects, d, sessionId + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function findTranscript(shellPid: number, procs: Proc[], configDir: string): { file: string } | { reason: NoTranscript } {
  const below = descendants(procs, shellPid);
  let registered = false;
  for (const p of below) {
    let meta: { sessionId?: unknown; cwd?: unknown };
    try { meta = JSON.parse(fs.readFileSync(path.join(configDir, 'sessions', p.pid + '.json'), 'utf8')); } catch { continue; }
    if (typeof meta.sessionId !== 'string' || !SESSION_ID.test(meta.sessionId)) continue;
    registered = true;
    const file = logFileOf(configDir, meta.sessionId, typeof meta.cwd === 'string' ? meta.cwd : '');
    if (file) return { file };
  }
  if (registered) return { reason: 'empty' };
  return { reason: below.some((p) => /claude/i.test(p.name)) ? 'no-transcript' : 'no-claude' };
}

/** The end of a log file; a line cut at the start is dropped. */
export function readTail(file: string, maxBytes: number): string {
  const size = fs.statSync(file).size;
  if (size <= maxBytes) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    const text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } finally { fs.closeSync(fd); }
}
