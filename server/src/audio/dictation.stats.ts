/**
 * How long the last dictations took from stop to text — numbers only, never
 * any dictated text. Feeds the speed display in the app's settings and is the
 * evidence for the 0.7s goal.
 *
 * Persisted to ~/.tms-terminal/dictation-stats.json (atomic write, owner-only).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DictationStat {
  /** When the stop arrived (ms since epoch). */
  at: number;
  audioSecs: number;
  /** Stop -> finished text, as measured on the server. */
  waitMs: number;
  /** Audio without a finished text when the stop arrived — including a piece that was being transcribed at that moment. */
  restSecs: number;
  /** No transcription had to be started after the stop (one already running ahead may still have been awaited). */
  specHit: boolean;
}

export interface DictationSummary {
  count: number;
  medianMs: number;
  /** Share (0..1) of dictations that took at most 700ms. */
  under700: number;
  /** Waits in ms, oldest first. */
  waits: number[];
}

const GOAL_MS = 700;

export class DictationStatsStore {
  private stats: DictationStat[] = [];

  constructor(private readonly file: string, private readonly keep = 50) {
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return; } // no file yet
    try {
      const data = JSON.parse(raw) as { stats?: unknown };
      if (!Array.isArray(data.stats)) throw new Error('no stats array');
      this.stats = (data.stats as DictationStat[]).filter((s) => s && Number.isFinite(s.waitMs)).slice(-keep);
    } catch {
      // Unreadable: keep it for inspection instead of overwriting it silently.
      try { fs.renameSync(file, file + '.bad'); } catch { /* best effort */ }
    }
  }

  record(stat: DictationStat): void {
    this.stats.push(stat);
    if (this.stats.length > this.keep) this.stats.splice(0, this.stats.length - this.keep);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, stats: this.stats }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* a full disk must not break dictation */ }
  }

  summary(): DictationSummary {
    const waits = this.stats.map((s) => s.waitMs);
    if (waits.length === 0) return { count: 0, medianMs: 0, under700: 0, waits: [] };
    const sorted = [...waits].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const medianMs = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    return { count: waits.length, medianMs, under700: waits.filter((w) => w <= GOAL_MS).length / waits.length, waits };
  }
}
