import { createHash } from 'crypto';

const WINDOW_MS = 20 * 60 * 1000;
const THRESHOLD = 3;
/** Upper bound on distinct signatures kept per terminal — this server runs for weeks. */
const MAX_SIGNATURES = 500;

/**
 * Lines that look like something went wrong. Deliberately broad — the repeat
 * count is the real filter.
 *
 * Two details that are easy to get wrong and were caught by tests:
 *  - `\w*error\b` rather than `\berror\b`, so `TypeError:` and `ReferenceError:`
 *    match. They are the most common JS failures and a leading `\b` misses them.
 *  - The trailing `\b` is what keeps the plural out: `0 errors` does NOT match,
 *    because `s` follows. A build printing "0 errors" every time must not look
 *    like a recurring problem.
 *  - `ERR!` carries no trailing `\b` at all — `!` is not a word character.
 */
const ERROR_RE = /(?:\w*error\b|\w*exception\b|\bfailed\b|\bfailure\b|\bfatal\b|\btraceback\b|ERR!|\bENOENT\b|\bECONNREFUSED\b|cannot find|cannot resolve|not found|\bpanic\b)/i;

export interface StuckSignal {
  sessionId: string;
  signature: string;
  count: number;
  /** The original line, so the model has something concrete to look at. */
  sample: string;
}

/**
 * Strip everything that varies between two occurrences of the same problem:
 * line numbers, paths, addresses, timestamps. What is left identifies the
 * *kind* of failure, which is what "going in circles" actually means.
 */
export function normalizeErrorLine(line: string): string {
  return line
    .replace(/0x[0-9a-fA-F]+/g, '0xH')
    .replace(/\b[0-9a-fA-F]{8,}\b/g, 'HASH')
    .replace(/(?:\/[\w.@\- ]+)+/g, '/P')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function errorSignature(line: string): string | null {
  if (!ERROR_RE.test(line)) return null;
  const normalized = normalizeErrorLine(line);
  if (normalized === '') return null;
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

interface Hit {
  times: number[];
  sample: string;
  lastSeen: number;
}

interface SessionState {
  hits: Map<string, Hit>;
  reported: Set<string>;
}

/**
 * Counts repeating error signatures per terminal. Model-free by design: this
 * runs on every byte of output, so it has to be cheap.
 */
export class StuckDetector {
  private sessions = new Map<string, SessionState>();

  constructor(
    private readonly now: () => number,
    private readonly threshold: number = THRESHOLD,
    private readonly windowMs: number = WINDOW_MS,
  ) {}

  /** Feed ANSI-stripped output. Returns a signal the first time a signature repeats enough. */
  feed(sessionId: string, cleanChunk: string): StuckSignal | null {
    const now = this.now();
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = { hits: new Map(), reported: new Set() };
      this.sessions.set(sessionId, state);
    }

    let signal: StuckSignal | null = null;

    for (const rawLine of cleanChunk.split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;
      const sig = errorSignature(line);
      if (sig === null) continue;
      if (state.reported.has(sig)) continue;

      let entry = state.hits.get(sig);
      if (entry === undefined) {
        entry = { times: [], sample: line, lastSeen: now };
        state.hits.set(sig, entry);
      }
      entry.times.push(now);
      entry.times = entry.times.filter(t => now - t <= this.windowMs);
      entry.lastSeen = now;

      if (entry.times.length >= this.threshold && signal === null) {
        state.reported.add(sig);
        state.hits.delete(sig); // reported once — stop tracking it
        signal = { sessionId, signature: sig, count: entry.times.length, sample: entry.sample };
      }
    }

    this.prune(state, now);
    return signal;
  }

  /** Number of signatures currently tracked for a terminal. Exposed for tests. */
  trackedSignatures(sessionId: string): number {
    return this.sessions.get(sessionId)?.hits.size ?? 0;
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * A terminal producing thousands of one-off errors would otherwise grow this
   * map forever. Drop anything that fell out of the window, and if that is still
   * not enough, drop the least recently seen.
   */
  private prune(state: SessionState, now: number): void {
    if (state.hits.size <= MAX_SIGNATURES) return;

    for (const [sig, hit] of state.hits) {
      if (now - hit.lastSeen > this.windowMs) state.hits.delete(sig);
    }
    if (state.hits.size <= MAX_SIGNATURES) return;

    const oldestFirst = [...state.hits.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [sig] of oldestFirst.slice(0, state.hits.size - MAX_SIGNATURES)) {
      state.hits.delete(sig);
    }
  }
}
