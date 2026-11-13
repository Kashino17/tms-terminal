/**
 * Terminal titles the user set, kept on the server — the single source of
 * truth. The phone's own store could lose them (reinstall, cleared app data)
 * and a second device never saw them. Keyed by sessionId, which is stable
 * across app restarts, server restarts (terminal keeper) and devices.
 *
 * Persisted to ~/.tms-terminal/titles.json (atomic write, owner-only).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_LEN = 80;

/** Trimmed, control characters removed, at most 80 characters; null if nothing is left. */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN).trim();
  return t ? t : null;
}

export class TitleStore {
  private titles = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  /** @param debounceMs  writes are coalesced; 0 = write on flush() only (tests). */
  constructor(private readonly file: string, private readonly debounceMs = 300) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const [id, v] of Object.entries(data ?? {})) {
        const t = cleanTitle(v);
        if (t) this.titles.set(id, t);
      }
    } catch { /* missing or broken file: start empty */ }
  }

  get(sessionId: string): string | undefined { return this.titles.get(sessionId); }

  all(): Record<string, string> { return Object.fromEntries(this.titles); }

  /** Returns true if the title actually changed (only then is it worth broadcasting). */
  set(sessionId: string, title: string): boolean {
    if (this.titles.get(sessionId) === title) return false;
    this.titles.set(sessionId, title);
    this.schedule();
    return true;
  }

  remove(sessionId: string): void {
    if (this.titles.delete(sessionId)) this.schedule();
  }

  /** Drop titles of terminals that no longer exist. */
  prune(live: Set<string>): void {
    let changed = false;
    for (const id of [...this.titles.keys()]) if (!live.has(id)) { this.titles.delete(id); changed = true; }
    if (changed) this.schedule();
  }

  private schedule(): void {
    if (this.debounceMs <= 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.debounceMs);
    this.timer.unref();
  }

  /** Write now (atomically: temp file + rename). Never throws. */
  flush(): Promise<void> {
    const snapshot = JSON.stringify(this.all(), null, 2);
    this.writing = this.writing.then(async () => {
      try {
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        await fs.promises.writeFile(tmp, snapshot, { mode: 0o600 });
        await fs.promises.rename(tmp, this.file);
      } catch { /* a lost write must not take anything down */ }
    });
    return this.writing;
  }
}
