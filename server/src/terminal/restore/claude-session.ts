import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

/** Claude Code keeps this itself — one file per running process. */
export const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

const PROC_TIMEOUT_MS = 1000;
const DEFAULT_MAX_DEPTH = 3;

export interface ClaudeSessionInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  status: 'busy' | 'idle' | 'shell';
}

export type ChildLookup = (pid: number) => Promise<number[]>;

function safePid(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 4194304) return null;
  return String(pid);
}

/** parent pid → its direct children. */
export type ProcessTable = Map<number, number[]>;

/**
 * Parse `ps -ax -o pid=,ppid=` into a parent→children map.
 * Unparseable lines are skipped rather than throwing.
 */
export function parseProcessTable(psOutput: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = table.get(ppid);
    if (list === undefined) table.set(ppid, [pid]);
    else list.push(pid);
  }
  return table;
}

/**
 * Read the whole process table in ONE call.
 *
 * Deliberately `ps` and not `pgrep -P`: measured on macOS 2026-07-29, `pgrep -P`
 * systematically misses children — eight parents on that machine reported fewer
 * children than `ps` did, usually exactly one short, and in some cases all of
 * them (`pgrep -P 88639` found nothing while `ps` found the claude process
 * hanging right below it). One `ps` call is also cheaper than one `pgrep` per
 * terminal.
 *
 * Note: `readForegroundProcess` in cwd.utils.ts still uses `pgrep -P` and is
 * likely affected by the same quirk.
 */
export function buildProcessTable(): Promise<ProcessTable> {
  return new Promise((resolve) => {
    execFile('ps', ['-ax', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: PROC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) { resolve(new Map()); return; }
        resolve(parseProcessTable(stdout));
      });
  });
}

export function childLookupFrom(table: ProcessTable): ChildLookup {
  return async (pid) => table.get(pid) ?? [];
}

/**
 * All descendants of `rootPid`, breadth-first, down to `maxDepth` levels.
 * `seen` guards against a cycle — a malformed process table must not hang the server.
 */
export async function descendantPids(
  rootPid: number,
  children: ChildLookup,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Promise<number[]> {
  const found: number[] = [];
  const seen = new Set<number>([rootPid]);
  let frontier = [rootPid];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const pid of frontier) {
      for (const child of await children(pid)) {
        if (seen.has(child)) continue;
        seen.add(child);
        found.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return found;
}

const VALID_STATUS = new Set(['busy', 'idle', 'shell']);

/**
 * Read ~/.claude/sessions/<pid>.json.
 *
 * The file's own `pid` field must match the pid we looked up: the OS reuses
 * PIDs, and without this an old file could be attributed to a stranger.
 */
export function readClaudeSessionFile(pid: number, sessionsDir: string): ClaudeSessionInfo | null {
  const arg = safePid(pid);
  if (arg === null) return null;
  const file = path.join(sessionsDir, `${arg}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null; // missing, unreadable or corrupt — all equally "no claude here"
  }
  const obj = raw as Record<string, unknown>;
  if (obj.pid !== pid) return null;
  if (typeof obj.sessionId !== 'string' || obj.sessionId === '') return null;

  const status = typeof obj.status === 'string' && VALID_STATUS.has(obj.status)
    ? obj.status as ClaudeSessionInfo['status']
    : 'idle'; // a status we do not know yet must not lose us the session

  return {
    pid,
    sessionId: obj.sessionId,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : '',
    status,
  };
}

/**
 * The Claude session running under a PTY shell, or null.
 *
 * Deliberately walks the process tree instead of scanning the sessions
 * directory: only a pid that provably hangs below this living shell may be
 * looked up, so a stale file from a session the user ended cannot resurrect it.
 */
export async function resolveClaudeSession(
  shellPid: number,
  opts: { children?: ChildLookup; sessionsDir?: string; maxDepth?: number } = {},
): Promise<ClaudeSessionInfo | null> {
  // Without an injected lookup this costs one `ps`. Callers resolving several
  // terminals at once should build the table themselves and pass childLookupFrom(),
  // so the whole snapshot needs a single process call.
  const children = opts.children ?? childLookupFrom(await buildProcessTable());
  const sessionsDir = opts.sessionsDir ?? CLAUDE_SESSIONS_DIR;
  try {
    for (const pid of await descendantPids(shellPid, children, opts.maxDepth)) {
      const info = readClaudeSessionFile(pid, sessionsDir);
      if (info !== null) return info;
    }
  } catch {
    return null; // pgrep missing or hanging — no claude mark, everything else still works
  }
  return null;
}
