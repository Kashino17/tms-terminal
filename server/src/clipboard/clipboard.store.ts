/**
 * Shared clipboard history — the last 40 texts copied on the phone or the Mac.
 * Kept on the server so every device sees the same list and it survives app
 * reinstalls. Persisted to ~/.tms-terminal/clipboard.json (atomic write,
 * owner-only: copied text can be private).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export type ClipSource = 'mac' | 'phone';
export interface ClipItem { id: string; text: string; source: ClipSource; at: number }

export const MAX_ITEMS = 40;
export const MAX_CHARS = 100_000;

/** What a single add changed: the new top item and the ids that dropped out. */
export interface ClipChange { item: ClipItem; removed: string[] }

export class ClipboardStore {
  private items: ClipItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  /** @param debounceMs  writes are coalesced; 0 = write on flush() only (tests). */
  constructor(private readonly file: string, private readonly debounceMs = 300) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (Array.isArray(data)) {
        this.items = data.filter((x): x is ClipItem =>
          !!x && typeof x.id === 'string' && typeof x.text === 'string' && x.text.length > 0
          && (x.source === 'mac' || x.source === 'phone') && typeof x.at === 'number',
        ).slice(0, MAX_ITEMS);
      }
    } catch { /* missing or broken file: start empty */ }
  }

  list(): ClipItem[] { return this.items.slice(); }

  /**
   * Puts `text` on top. The same text copied again moves up instead of
   * appearing twice (the list is "what did I copy lately", not a log).
   * Returns null for text that is blank or too large to be worth keeping.
   */
  add(text: string, source: ClipSource, now = Date.now()): ClipChange | null {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_CHARS) return null;
    const removed: string[] = [];
    this.items = this.items.filter((x) => {
      if (x.text !== text) return true;
      removed.push(x.id);
      return false;
    });
    const item: ClipItem = { id: randomBytes(6).toString('hex'), text, source, at: now };
    this.items.unshift(item);
    while (this.items.length > MAX_ITEMS) removed.push(this.items.pop()!.id);
    this.schedule();
    return { item, removed };
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    if (this.items.length === before) return false;
    this.schedule();
    return true;
  }

  /** Empties the list; returns the ids that were in it. */
  clear(): string[] {
    const ids = this.items.map((x) => x.id);
    this.items = [];
    if (ids.length) this.schedule();
    return ids;
  }

  private schedule(): void {
    if (this.debounceMs <= 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.debounceMs);
    this.timer.unref();
  }

  /** Write now (atomically: temp file + rename). Never throws. */
  flush(): Promise<void> {
    const snapshot = JSON.stringify(this.items);
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
