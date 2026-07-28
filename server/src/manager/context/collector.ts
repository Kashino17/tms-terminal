import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { readStore, writeStore, MANAGER_DIR } from '../store';
import { logger } from '../../utils/logger';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const FILE = 'projects.json';

/** Head is enough for cwd/gitBranch; the tail carries the title and the end time. */
const HEAD_BYTES = 16 * 1024;
const TAIL_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 3000;

export interface SessionFacts {
  sessionId: string;
  title: string;
  startedAt: number;
  endedAt: number;
  promptCount: number;
}

export interface ProjectFacts {
  key: string;
  path: string;
  name: string;
  lastActivityAt: number;
  gitBranch?: string;
  lastCommitAt?: number;
  lastCommitSubject?: string;
  recentSessions: SessionFacts[];
  claudeMdSummary?: string;
  collectedAt: number;
}

export interface TranscriptFacts {
  cwd?: string;
  gitBranch?: string;
  title?: string;
  sessionId?: string;
  startedAt?: number;
  endedAt?: number;
  promptCount: number;
}

/** Read only the ends of a possibly huge file. Transcripts reach tens of MB. */
function readHeadAndTail(file: string): string {
  const size = fs.statSync(file).size;
  if (size <= HEAD_BYTES + TAIL_BYTES) return fs.readFileSync(file, 'utf-8');

  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    fs.readSync(fd, head, 0, HEAD_BYTES, 0);
    const tail = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    return head.toString('utf-8') + '\n' + tail.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Pull what we need out of one Claude Code transcript. This is someone else's
 * private format (today `version: 2.1.220`) — every field is optional and a
 * parse failure costs one line, never the whole file.
 */
export function readTranscriptFacts(file: string): TranscriptFacts {
  const out: TranscriptFacts = { promptCount: 0 };
  let raw: string;
  try {
    raw = readHeadAndTail(file);
  } catch {
    return out;
  }

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a truncated line in the middle is normal when reading head+tail
    }

    if (typeof obj.cwd === 'string' && out.cwd === undefined) out.cwd = obj.cwd;
    if (typeof obj.gitBranch === 'string') out.gitBranch = obj.gitBranch;
    if (typeof obj.sessionId === 'string' && out.sessionId === undefined) out.sessionId = obj.sessionId;
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') out.title = obj.aiTitle;
    if (obj.type === 'last-prompt') out.promptCount++;

    if (typeof obj.timestamp === 'string') {
      const t = Date.parse(obj.timestamp);
      if (!Number.isNaN(t)) {
        if (out.startedAt === undefined || t < out.startedAt) out.startedAt = t;
        if (out.endedAt === undefined || t > out.endedAt) out.endedAt = t;
      }
    }
  }
  return out;
}

/**
 * Branch and last commit via plumbing only.
 * `git status` is forbidden here: on the iCloud-backed Desktop it can hang for
 * minutes, and this runs every two minutes.
 */
export function gitFacts(repoPath: string): {
  branch?: string; lastCommitAt?: number; lastCommitSubject?: string;
} {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', ['-C', repoPath, ...args], {
        encoding: 'utf-8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null; // not a repo, git missing, or timed out — all equally fine
    }
  };

  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const last = run(['log', '-1', '--format=%ct%n%s']);
  const out: { branch?: string; lastCommitAt?: number; lastCommitSubject?: string } = {};
  if (branch !== null && branch !== '') out.branch = branch;
  if (last !== null && last !== '') {
    const [ts, ...rest] = last.split('\n');
    const secs = Number(ts);
    if (Number.isFinite(secs)) out.lastCommitAt = secs * 1000;
    if (rest.length > 0) out.lastCommitSubject = rest.join(' ');
  }
  return out;
}

function readClaudeMdSummary(repoPath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(repoPath, 'CLAUDE.md'), 'utf-8').slice(0, 600);
  } catch {
    return undefined;
  }
}

export function collectProjects(opts: {
  projectsDir?: string; maxProjects?: number; sessionsPerProject?: number;
  /**
   * Facts from the last run. Projects whose newest transcript has not moved are
   * reused untouched — no transcript parsing, no git call. This runs every two
   * minutes, so the steady-state cost has to be a readdir plus a few stats.
   */
  previous?: ProjectFacts[];
} = {}): ProjectFacts[] {
  const root = opts.projectsDir ?? CLAUDE_PROJECTS_DIR;
  const sessionsPerProject = opts.sessionsPerProject ?? 5;
  const maxProjects = opts.maxProjects ?? 40;
  const previousByKey = new Map((opts.previous ?? []).map(p => [p.key, p]));

  let dirs: string[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return []; // no Claude Code on this machine — not an error
  }

  const projects: ProjectFacts[] = [];

  for (const key of dirs) {
    const dir = path.join(root, key);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    const withTime = files
      .map(f => {
        const full = path.join(dir, f);
        // stat.mtime (whole milliseconds) rather than stat.mtimeMs (which carries
        // sub-millisecond digits). The cache check below compares these for exact
        // equality, and only the millisecond value survives a filesystem round-trip.
        try { return { full, mtime: fs.statSync(full).mtime.getTime() }; } catch { return null; }
      })
      .filter((x): x is { full: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);

    if (withTime.length === 0) continue;

    // Nothing new since last time? Reuse what we already know.
    const cached = previousByKey.get(key);
    if (cached !== undefined && cached.lastActivityAt === withTime[0].mtime) {
      projects.push(cached);
      continue;
    }

    const sessions: SessionFacts[] = [];
    let projectPath: string | undefined;
    let gitBranch: string | undefined;

    for (const { full, mtime } of withTime.slice(0, sessionsPerProject)) {
      const facts = readTranscriptFacts(full);
      if (projectPath === undefined && facts.cwd !== undefined) projectPath = facts.cwd;
      if (gitBranch === undefined && facts.gitBranch !== undefined) gitBranch = facts.gitBranch;
      sessions.push({
        sessionId: facts.sessionId ?? path.basename(full, '.jsonl'),
        title: facts.title ?? '(ohne Titel)',
        startedAt: facts.startedAt ?? mtime,
        endedAt: facts.endedAt ?? mtime,
        promptCount: facts.promptCount,
      });
    }

    const resolvedPath = projectPath ?? key;
    const git = projectPath !== undefined ? gitFacts(projectPath) : {};

    projects.push({
      key,
      path: resolvedPath,
      name: path.basename(resolvedPath),
      lastActivityAt: withTime[0].mtime,
      gitBranch: git.branch ?? gitBranch,
      lastCommitAt: git.lastCommitAt,
      lastCommitSubject: git.lastCommitSubject,
      recentSessions: sessions,
      claudeMdSummary: projectPath !== undefined ? readClaudeMdSummary(projectPath) : undefined,
      collectedAt: Date.now(),
    });
  }

  return projects
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, maxProjects);
}

export function loadProjectFacts(dir: string = MANAGER_DIR): ProjectFacts[] {
  return readStore<{ projects: ProjectFacts[] }>(FILE, { projects: [] }, dir).projects;
}

export function saveProjectFacts(projects: ProjectFacts[], dir: string = MANAGER_DIR): void {
  writeStore(FILE, { projects }, dir);
}

/** Refresh the store. Never throws — one bad signal must not kill the collector. */
export function refreshProjectFacts(dir: string = MANAGER_DIR): ProjectFacts[] {
  try {
    const projects = collectProjects({ previous: loadProjectFacts(dir) });
    saveProjectFacts(projects, dir);
    return projects;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[collector] refresh failed, keeping previous facts: ${msg}`);
    return loadProjectFacts(dir);
  }
}
